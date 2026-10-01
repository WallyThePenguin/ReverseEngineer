// The Jarvis service: the reflex engine and the turn runner, woken by new events.
import {
  ensureRoutineSchedules,
  getSetting,
  type Kernel,
  listenForEvents,
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
  const runner = new TurnRunner({ kernel: opts.kernel, brain: opts.brain, pool: opts.pool, log });
  let stopped = false;
  let wake: () => void = () => {};

  const workers = Array.from({ length: opts.concurrency ?? 2 }, async () => {
    while (!stopped) {
      const turn = await runner.claimNext().catch((err) => {
        log("claiming a turn failed", err);
        return null;
      });
      if (turn) {
        await runner.run(turn);
        continue;
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, opts.pollMs ?? 2000);
        const prev = wake;
        wake = () => {
          clearTimeout(t);
          wake = prev;
          resolve();
        };
      });
    }
  });

  const engine = new ReflexEngine({ kernel: opts.kernel, log, onTurnQueued: () => wake() });
  await registerRoutines(opts.kernel);
  const interrupted = await runner.recoverInterrupted();
  if (interrupted) log(`${interrupted} turn(s) were interrupted by the last restart`);

  const kick = () =>
    void engine.processAvailable().catch((err) => log("reflex engine failed", err));
  const unlisten = listenForEvents(opts.pool, kick);
  const poll = setInterval(kick, opts.pollMs ?? 2000);
  kick();

  return {
    engine,
    runner,
    async stop() {
      stopped = true;
      clearInterval(poll);
      await unlisten();
      wake();
      await Promise.allSettled(workers);
    },
  };
}
