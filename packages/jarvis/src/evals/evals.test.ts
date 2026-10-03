// The eval suite in CI: every scenario's recorded fixture replays and still passes.
import { describe, expect, it } from "vitest";
import { replayScenario } from "./run.ts";
import { SCENARIOS } from "./scenarios.ts";

describe("Jarvis evals (recorded)", () => {
  for (const s of SCENARIOS) {
    it(`${s.name}: ${s.description}`, async () => {
      const r = await replayScenario(s);
      expect(r.failures).toEqual([]);
    });
  }
});
