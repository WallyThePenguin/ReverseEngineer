// The worker reports in every minute, but it can't say that it has stopped, and while it's down
// nothing else checks Hearth's health: schedules, syncs and reminders just wait. The server
// notices for it. Once the worker's last report is five minutes old you're told, once per
// outage. The alert is an interrupt, so it reaches your phone.
import { formatDateTime } from "@hearth/core";
import { setting } from "@hearth/db";
import { getSetting, type Kernel, systemCaller } from "@hearth/kernel";
import { eq } from "drizzle-orm";

export const WORKER_STALE_MS = 5 * 60_000;

export type WorkerCheck = "never" | "ok" | "told" | "already told";

export function workerWatch(kernel: Kernel) {
  /** The outage already told about, by the worker's last report time. */
  let told: string | null = null;
  return async function check(): Promise<WorkerCheck> {
    const [row] = await kernel.db.select().from(setting).where(eq(setting.key, "health.worker"));
    // Never reported: not set up yet, or a fresh install still starting.
    if (!row) return "never";
    const at = (row.value as { at: string }).at;
    const now = kernel.clock.now();
    if (now.getTime() - new Date(at).getTime() <= WORKER_STALE_MS) return "ok";
    if (told === at) return "already told";
    const { timeZone } = await getSetting(kernel.db, "owner.dayRules");
    const res = await kernel.execute(
      "inbox.notify",
      {
        kind: "system.alert",
        title: "Hearth's worker has stopped",
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
export function startWorkerWatch(kernel: Kernel, everyMs = 60_000): () => void {
  const check = workerWatch(kernel);
  const timer = setInterval(() => {
    check().catch((err) =>
      console.warn(`[server] checking on the worker failed: ${(err as Error).message}`),
    );
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
