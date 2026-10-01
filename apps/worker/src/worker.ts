// The worker: fires schedules (routines, reminders, checks) and keeps an eye on Hearth's health.
import { type Kernel, startScheduler } from "@hearth/kernel";
import { checkHealth, type HealthOptions, reportHealth } from "./health.ts";

export interface WorkerOptions extends HealthOptions {
  kernel: Kernel;
  scheduleIntervalMs?: number;
  healthIntervalMs?: number;
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
  return {
    health,
    tick: scheduler.tick,
    stop() {
      clearInterval(timer);
      scheduler.stop();
    },
  };
}
