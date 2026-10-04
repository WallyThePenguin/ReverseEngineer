// The Jarvis service: the reflex engine and the turn runner, woken by new events. It sets
// itself up first and only then starts working, so a failed start ends the process instead of
// leaving it half alive (D54).
import {
  ensureRoutineSchedules,
  getSetting,
  type Kernel,
  listenChannels,
  listenForEvents,
  setSetting,
  upsertSchedule,
} from "@hearth/kernel";
import { CANCEL_CHANNEL } from "@hearth/modules";
import type pg from "pg";
import type { Brain } from "./brain.ts";
import { ReflexEngine } from "./engine.ts";
import { HEARTBEAT } from "./heartbeat.ts";
import { type RunnerOptions, TurnRunner } from "./runner.ts";

export interface JarvisServiceOptions {
  kernel: Kernel;
  pool: pg.Pool;
  brain: Brain;
  /** Turns run at once. Two lets a quick chat answer while a long task runs. */
  concurrency?: number;
  pollMs?: number;
  /** How often Jarvis says it's alive and reports its health. */
  checkInMs?: number;
  log?: (msg: string, err?: unknown) => void;
  runner?: Pick<RunnerOptions, "limits" | "turnLog" | "stopCheckMs">;
}

/** Registers every routine (module routines plus the heartbeat) with the scheduler. */
export async function registerRoutines(kernel: Kernel): Promise<void> {
  const now = kernel.clock.now();
  const rules = await getSetting(kernel.db, "owner.dayRules");
  await ensureRoutineSchedules(kernel.db, kernel.registry, now, rules.timeZone);
  await upsertSchedule(
    kernel.db,
    {
      id: `routine:${HEARTBEAT.name}`,
      kind: "routine",
      cron: HEARTBEAT.cron,
      timeZone: rules.timeZone,
      payload: { routine: HEARTBEAT.name },
      staleAfterSeconds: HEARTBEAT.staleAfterSeconds,
    },
    now,
  );
}

export async function startJarvis(opts: JarvisServiceOptions) {
  const log = opts.log ?? ((m: string, e?: unknown) => console.error(`[jarvis] ${m}`, e ?? ""));
  const { kernel } = opts;
  const runner = new TurnRunner({
    kernel,
    brain: opts.brain,
    pool: opts.pool,
    log,
    ...opts.runner,
  });
  const pollMs = opts.pollMs ?? 2000;

  // Set up first: any failure here throws before a loop has started.
  await registerRoutines(kernel);
  const interrupted = await runner.recoverInterrupted();
  if (interrupted) log(`${interrupted} turn(s) were interrupted by the last restart`);

  let stopped = false;
  // Idle workers wait here until a turn is queued or the poll interval passes.
  const waiters = new Set<() => void>();
  const wakeOne = () => {
    const [first] = waiters;
    first?.();
  };
  const idle = () =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, pollMs);
      waiters.add(done);
    });

  const workers = Array.from({ length: opts.concurrency ?? 2 }, async () => {
    while (!stopped) {
      const turn = await runner.claimNext().catch((err) => {
        log("claiming a turn failed", err);
        return null;
      });
      if (turn) await runner.run(turn);
      else await idle();
    }
  });

  const engine = new ReflexEngine({ kernel, log, onTurnQueued: wakeOne });
  const kick = () =>
    void engine.processAvailable().catch((err) => log("reflex engine failed", err));
  const unlisten = listenForEvents(opts.pool, kick);
  // Stop, pressed in a chat (jarvis.cancel_turn).
  const unlistenStop = listenChannels(opts.pool, [CANCEL_CHANNEL], (_ch, turnId) => {
    if (runner.cancel(turnId)) log(`turn ${turnId} stopped by the owner`);
  });
  const poll = setInterval(kick, pollMs);
  kick();

  // Tell the worker Jarvis is alive, and how its turns are going; if this stops, the worker
  // restarts Jarvis and tells you.
  const since = new Date().toISOString();
  const checkIn = () =>
    void setSetting(kernel.db, "jarvis.alive", {
      at: kernel.clock.now().toISOString(),
      since,
      pid: process.pid,
    })
      .then(() => runner.reportHealth())
      .catch((err) => log("health check-in failed", err));
  const heartbeat = setInterval(checkIn, opts.checkInMs ?? 30_000);
  checkIn();

  return {
    engine,
    runner,
    async stop() {
      stopped = true;
      clearInterval(poll);
      clearInterval(heartbeat);
      await unlisten();
      await unlistenStop();
      for (const w of [...waiters]) w();
      await Promise.allSettled(workers);
    },
  };
}
