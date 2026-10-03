// Runs eval scenarios: live with a real model (optionally recording fixtures), or replaying
// recorded fixtures.
import { readFileSync, writeFileSync } from "node:fs";
import { jarvisTurn } from "@hearth/db";
import type { Brain } from "../brain.ts";
import { createJarvisHarness } from "../testing.ts";
import { type Fixture, RecordingBrain, ReplayBrain } from "./recorded.ts";
import { connectGoogle, type Scenario, withGoogle } from "./scenarios.ts";

export interface EvalResult {
  scenario: string;
  passed: boolean;
  failures: string[];
  turns: number;
}

export const fixturePath = (name: string) => new URL(`./fixtures/${name}.json`, import.meta.url);

export function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(fixturePath(name), "utf8")) as Fixture;
}

async function run(
  scenario: Scenario,
  brain: RecordingBrain | ReplayBrain,
  after?: (b: RecordingBrain | ReplayBrain) => string[],
): Promise<EvalResult> {
  const h = await createJarvisHarness(scenario.start, { brain });
  brain.db = h.tdb.db;
  const failures: string[] = [];
  let turns = 0;
  try {
    const g = withGoogle(h);
    await connectGoogle(h, g);
    await scenario.setup(h, g);
    await scenario.act(h);
    failures.push(...(await scenario.check(h, g)));
    const rows = await h.tdb.db.select().from(jarvisTurn);
    turns = rows.length;
    for (const t of rows)
      if (t.status === "failed") failures.push(`turn failed: ${t.error ?? "unknown"}`);
    for (const want of scenario.promptHas ?? [])
      if (!brain.requests.some((r) => r.system.includes(want)))
        failures.push(`no turn's prompt included "${want}"`);
    failures.push(...(after?.(brain) ?? []));
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
  } finally {
    await h.destroy();
  }
  return { scenario: scenario.name, passed: failures.length === 0, failures, turns };
}

/** Runs a scenario with a real model. With `record`, saves what it did as the fixture. */
export async function runLive(
  scenario: Scenario,
  brain: Brain,
  opts: { record?: string } = {},
): Promise<EvalResult> {
  const recorder = new RecordingBrain(brain);
  const result = await run(scenario, recorder);
  if (opts.record && result.passed) {
    const fixture: Fixture = {
      scenario: scenario.name,
      recordedWith: opts.record,
      recordedAt: new Date().toISOString(),
      turns: recorder.turns,
    };
    writeFileSync(fixturePath(scenario.name), `${JSON.stringify(fixture, null, 2)}\n`);
  }
  return result;
}

/** Replays a scenario's recorded fixture. */
export function replayScenario(scenario: Scenario): Promise<EvalResult> {
  return run(scenario, new ReplayBrain(loadFixture(scenario.name)), (b) => {
    const left = (b as ReplayBrain).unplayed;
    return left ? [`${left} recorded turns never ran: the scenario took a different path`] : [];
  });
}
