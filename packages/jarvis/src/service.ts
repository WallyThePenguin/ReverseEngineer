// The Jarvis service: the reflex engine and the turn runner, woken by new events.
import {
  ensureRoutineSchedules,
  getSetting,
  type Kernel,
  listenForEvents,
  systemCaller,
  upsertSchedule,
} from "@hearth/kernel";
import type pg from "pg";
import type { Brain } from "./brain.ts";
import { ReflexEngine } from "./engine.ts";
import { HEARTBEAT } from "./heartbeat.ts";
import { TurnRunner } from "./runner.ts";

export interface JarvisServiceOptions {
  kernel: Kernel;
  pool: pg.Pool;
  brain: Brain;
  /** Turns run at once. Two lets a quick chat answer while a long task runs. */
  concurrency?: number;
  pollMs?: number;
  log?: (msg: string, err?: unknown) => void;
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
  const runner = new TurnRunner({ kernel, brain: opts.brain, pool: opts.pool, log });
  const pollMs = opts.pollMs ?? 2000;
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
  await registerRoutines(kernel);
  const interrupted = await runner.recoverInterrupted();
  if (interrupted) log(`${interrupted} turn(s) were interrupted by the last restart`);

  const kick = () =>
    void engine.processAvailable().catch((err) => log("reflex engine failed", err));
  const unlisten = listenForEvents(opts.pool, kick);
  const poll = setInterval(kick, pollMs);
  kick();

  // Tell the worker Jarvis is alive; if this stops, it alerts you.
  const checkIn = () =>
    void kernel
      .execute(
        "system.report",
        { component: "jarvis", status: "ok", detail: "Running" },
        systemCaller(),
      )
      .catch((err) => log("health check-in failed", err));
  const heartbeat = setInterval(checkIn, 60_000);
  checkIn();

  return {
    engine,
    runner,
    async stop() {
      stopped = true;
      clearInterval(poll);
      clearInterval(heartbeat);
      await unlisten();
      for (const w of [...waiters]) w();
      await Promise.allSettled(workers);
    },
  };
}
