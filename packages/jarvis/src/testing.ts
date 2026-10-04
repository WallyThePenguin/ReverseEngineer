// A harness that runs the whole spine (scheduler, reflex engine, turn runner) against a test
// database with a scripted brain and a manual clock.
import { runDueSchedules } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { ALL_MODULES } from "@hearth/modules";
import type { Brain } from "./brain.ts";
import { ScriptedBrain } from "./brains/scripted.ts";
import { ReflexEngine } from "./engine.ts";
import { type RunnerOptions, TurnRunner } from "./runner.ts";
import { registerRoutines } from "./service.ts";

export interface JarvisHarness extends TestKernel {
  brain: ScriptedBrain;
  engine: ReflexEngine;
  runner: TurnRunner;
  logs: string[];
  /** Fires due schedules, runs reflexes and turns until nothing is left to do. */
  settle(): Promise<{ fired: number; events: number; turns: number }>;
}

export async function createJarvisHarness(
  start?: string,
  opts: { brain?: Brain; runner?: Pick<RunnerOptions, "limits" | "turnLog" | "stopCheckMs"> } = {},
): Promise<JarvisHarness> {
  const t = await createTestKernel(ALL_MODULES, start);
  const logs: string[] = [];
  const log = (m: string, e?: unknown) =>
    logs.push(`${m}${e ? ` ${e instanceof Error ? e.message : JSON.stringify(e)}` : ""}`);
  const brain = new ScriptedBrain();
  const engine = new ReflexEngine({ kernel: t.kernel, log });
  const runner = new TurnRunner({
    kernel: t.kernel,
    brain: opts.brain ?? brain,
    log,
    ...opts.runner,
  });
  await registerRoutines(t.kernel);
  return {
    ...t,
    brain,
    engine,
    runner,
    logs,
    async settle() {
      const total = { fired: 0, events: 0, turns: 0 };
      for (let i = 0; i < 25; i++) {
        const fired = await runDueSchedules(t.kernel.db, t.clock);
        const events = await engine.processAvailable();
        const turns = await runner.drain();
        total.fired += fired;
        total.events += events;
        total.turns += turns;
        if (fired + events + turns === 0) return total;
      }
      throw new Error("Jarvis never settled (a loop?)");
    },
  };
}
