// The worker reports in every minute, but it can't say that it has stopped, and while it's down
// nothing else checks Hearth's health: schedules, syncs and reminders just wait. The server
// notices for it. Once the worker's last report is five minutes old you're told, once per
// outage. The alert is an interrupt, so it reaches your phone.
//
// After the server starts, and after the PC wakes from sleep, the worker gets the same five
// minutes to check in before anything counts: on waking both processes' timers are overdue, and
// the server's may run before the worker has reported.
import { formatDateTime } from "@hearth/core";
import { setting } from "@hearth/db";
import { getSetting, type Kernel, systemCaller } from "@hearth/kernel";
import { eq } from "drizzle-orm";

export const WORKER_STALE_MS = 5 * 60_000;
/** How often the server looks. */
export const WATCH_EVERY_MS = 60_000;

export type WorkerCheck = "never" | "ok" | "waiting" | "told" | "already told";

export function workerWatch(kernel: Kernel, everyMs = WATCH_EVERY_MS) {
  /** The outage already told about, by the worker's last report time. */
  let told: string | null = null;
  /** When the server last looked, and since when it has been looking without a gap. */
  let lastLook: number | null = null;
  let awakeSince = 0;
  return async function check(): Promise<WorkerCheck> {
    const now = kernel.clock.now().getTime();
    // A look far later than it was due: the PC was asleep (or this is the first).
    if (lastLook === null || now - lastLook > 3 * everyMs) awakeSince = now;
    lastLook = now;
    const [row] = await kernel.db.select().from(setting).where(eq(setting.key, "health.worker"));
    // Never reported: not set up yet, or a fresh install still starting.
    if (!row) return "never";
    const at = (row.value as { at: string }).at;
    if (now - new Date(at).getTime() <= WORKER_STALE_MS) return "ok";
    if (now - awakeSince <= WORKER_STALE_MS) return "waiting";
    if (told === at) return "already told";
    const { timeZone } = await getSetting(kernel.db, "owner.dayRules");
    const res = await kernel.execute(
      "inbox.notify",
      {
        kind: "system.alert",
        title: "Nook's worker has stopped",
        body: `It hasn't checked in since ${formatDateTime(new Date(at), timeZone)}. Until it's back, schedules, reminders, syncs and health checks wait. Windows starts it again by itself; if this stays, run: hearth restart worker`,
        urgency: "interrupt",
        dedupeKey: `worker_down:${at}`,
      },
      systemCaller(),
    );
    if (res.status !== "ok") throw new Error(`the alert wasn't raised: ${JSON.stringify(res)}`);
    told = at;
    return "told";
  };
}

/** Checks every minute until stopped. */
export function startWorkerWatch(kernel: Kernel, everyMs = WATCH_EVERY_MS): () => void {
  const check = workerWatch(kernel, everyMs);
  const timer = setInterval(() => {
    check().catch((err) =>
      console.warn(`[server] checking on the worker failed: ${(err as Error).message}`),
    );
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
