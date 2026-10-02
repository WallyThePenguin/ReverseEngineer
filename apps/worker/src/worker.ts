// The worker: fires schedules (routines, reminders, checks), checks watched pages, and keeps an
// eye on Hearth's health.
import { type Kernel, startScheduler } from "@hearth/kernel";
import { checkHealth, type HealthOptions, reportHealth } from "./health.ts";
import { checkDueWatches } from "./watches.ts";

export interface WorkerOptions extends HealthOptions {
  kernel: Kernel;
  scheduleIntervalMs?: number;
  healthIntervalMs?: number;
  watchIntervalMs?: number;
  log?: (msg: string, err?: unknown) => void;
}

export function startWorker(opts: WorkerOptions) {
  const log = opts.log ?? ((m: string, e?: unknown) => console.error(`[worker] ${m}`, e ?? ""));
  const { kernel } = opts;
  const scheduler = startScheduler(kernel.db, kernel.clock, {
    intervalMs: opts.scheduleIntervalMs ?? 5000,
    log: (err) => log("running schedules failed", err),
  });
  let checking = false;
  const health = async () => {
    if (checking) return;
    checking = true;
    try {
      await reportHealth(kernel, await checkHealth(kernel, opts));
    } catch (err) {
      log("health check failed", err);
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(health, opts.healthIntervalMs ?? 60_000);
  void health();

  let watching = false;
  const watches = async () => {
    if (watching) return 0;
    watching = true;
    try {
      return await checkDueWatches(kernel, 5, (m) => log(m));
    } catch (err) {
      log("checking page watches failed", err);
      return 0;
    } finally {
      watching = false;
    }
  };
  const watchTimer = setInterval(watches, opts.watchIntervalMs ?? 60_000);

  return {
    health,
    watches,
    tick: scheduler.tick,
    stop() {
      clearInterval(timer);
      clearInterval(watchTimer);
      scheduler.stop();
    },
  };
}
