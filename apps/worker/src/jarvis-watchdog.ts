// Restarts Jarvis when it stops checking in (D54). Jarvis writes jarvis.alive every 30 seconds;
// when that goes quiet for a few minutes the worker runs the "Hearth Jarvis" scheduled task,
// which starts Jarvis again if it isn't running, and tells you. Only the installed worker on
// Windows does this: anywhere else it just watches.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { formatTime } from "@hearth/core";
import { notification } from "@hearth/db";
import { getSetting, type Kernel, systemCaller } from "@hearth/kernel";
import { and, eq, gte, isNull } from "drizzle-orm";

export const JARVIS_TASK = "Hearth Jarvis";

export interface WatchdogOptions {
  /** How long Jarvis may go without checking in before it's restarted. */
  staleMs?: number;
  /** The least time between two restarts. */
  gapMs?: number;
  /** Starts Jarvis; by default, runs the scheduled task. Throws when Windows says no. */
  restart?: () => Promise<void>;
  /** Whether to restart at all. By default, only as the installed worker on Windows. */
  enabled?: boolean;
  log?: (msg: string, err?: unknown) => void;
}

export type WatchdogResult = "ok" | "never" | "off" | "waiting" | "restarted" | "failed";

const SCHTASKS = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "schtasks.exe");

/** Asks Windows to run the Jarvis task (the installer lets the worker's account do just that). */
export const runJarvisTask = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const opts = { timeout: 10_000, windowsHide: true };
    execFile(SCHTASKS, ["/Run", "/TN", JARVIS_TASK], opts, (err, stdout, stderr) => {
      if (!err) return resolve();
      const why = `${stderr}\n${stdout}`.split(/\r?\n/).find((l) => l.trim()) ?? err.message;
      reject(new Error(`schtasks couldn't run "${JARVIS_TASK}": ${why.trim()}`));
    });
  });

/**
 * Interrupts held for quiet hours are sent in the morning by Jarvis. While Jarvis is down the
 * worker sends them instead, or "Jarvis won't stay running" would wait for Jarvis itself (D54).
 * inbox.deliver still applies quiet hours and the day's budget; only the last day's are sent.
 */
export async function deliverHeld(kernel: Kernel): Promise<number> {
  const since = new Date(kernel.clock.now().getTime() - 24 * 3600_000);
  const held = await kernel.db
    .select({ id: notification.id })
    .from(notification)
    .where(
      and(
        eq(notification.urgency, "interrupt"),
        isNull(notification.deliveredAt),
        eq(notification.state, "unseen"),
        eq(notification.deferredReason, "quiet_hours"),
        gte(notification.createdAt, since),
      ),
    )
    .limit(20);
  let sent = 0;
  for (const { id } of held) {
    const res = await kernel.execute<{ delivered: boolean }>(
      "inbox.deliver",
      { id },
      systemCaller(),
    );
    if (res.status === "ok" && res.result.delivered) sent++;
  }
  return sent;
}

/** A check to run every minute or so. */
export function jarvisWatchdog(kernel: Kernel, opts: WatchdogOptions = {}) {
  const staleMs = opts.staleMs ?? 3 * 60_000;
  const gapMs = opts.gapMs ?? 15 * 60_000;
  const restart = opts.restart ?? runJarvisTask;
  const enabled =
    opts.enabled ?? (process.platform === "win32" && process.env.HEARTH_AS_SERVICE === "1");
  const log = opts.log ?? (() => {});
  let last: { at: number; outage: string } | null = null;
  const startedAt = kernel.clock.now().getTime();

  return async function check(): Promise<WatchdogResult> {
    const alive = await getSetting(kernel.db, "jarvis.alive");
    // A Jarvis that has never checked in is one from before D54, or not set up: leave it be.
    if (!alive) return "never";
    const now = kernel.clock.now();
    const seen = new Date(alive.at);
    if (now.getTime() - seen.getTime() <= staleMs) return "ok";
    await deliverHeld(kernel).catch((err) => log("sending held interrupts failed", err));
    if (!enabled) return "off";
    // The worker just started, as after a reboot: Jarvis starts when you sign in, so it gets the
    // same few minutes to check in before it's restarted and you're told.
    if (now.getTime() - startedAt < staleMs) return "waiting";
    if (last && now.getTime() - last.at < gapMs) return "waiting";
    // The same outage as the last restart: that one didn't bring Jarvis back.
    const again = last?.outage === alive.at;
    last = { at: now.getTime(), outage: alive.at };
    const { timeZone } = await getSetting(kernel.db, "owner.dayRules");
    const since = formatTime(seen, timeZone);
    let failed: string | null = null;
    try {
      await restart();
      log(`Jarvis hadn't checked in since ${alive.at}, so the worker started its task`);
    } catch (err) {
      failed = err instanceof Error ? err.message : String(err);
      log("restarting Jarvis failed", err);
    }
    const stuck = again || failed !== null;
    const res = await kernel.execute(
      "inbox.notify",
      stuck
        ? {
            kind: "system.alert",
            title: "Jarvis won't stay running",
            body: `Jarvis hasn't checked in since ${since}, and Hearth couldn't bring it back. Its log is hearth-jarvis.log in Hearth's services folder.`,
            urgency: "interrupt",
            dedupeKey: `jarvis_stuck:${alive.at}`,
          }
        : {
            kind: "system.alert",
            title: "Jarvis stopped, so Hearth restarted it",
            body: `Jarvis hadn't checked in since ${since}. If it doesn't come back in a few minutes, you'll hear about it again.`,
            urgency: "normal",
            dedupeKey: `jarvis_restarted:${alive.at}`,
          },
      systemCaller(),
    );
    if (res.status !== "ok") log(`the Jarvis restart alert wasn't raised: ${JSON.stringify(res)}`);
    return failed ? "failed" : "restarted";
  };
}
