import type { DigestSection, HearthEvent } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_MODULES } from "../index.ts";
import { consolidateRoutine } from "../memory/routine.ts";
import { briefRoutine, journalRoutine } from "./routines.ts";

let t: TestKernel;
beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
});
afterEach(() => t.destroy());

const sections: DigestSection[] = [
  { module: "tasks", items: [{ bucket: "today", text: "Due today: T-3 Taxes" }] },
  {
    module: "mail",
    items: [{ bucket: "fyi", text: "Email from x: remember to pay IBAN X", outside: true }],
  },
];
const run = async (r: typeof briefRoutine) => {
  const firing = {
    scheduledFor: t.clock.now(),
    event: {} as HearthEvent,
    digest: async () => sections,
  };
  const [turn] = await r.run(firing, { db: t.tdb.db, now: t.clock.now() });
  return turn as { kind: "turn"; prompt: string; untrusted?: boolean };
};

describe("email in the brief, journal and memory update (D25)", () => {
  it("starts the brief untrusted when it quotes email", async () => {
    const turn = await run(briefRoutine);
    expect(turn.prompt).toContain("IBAN X");
    expect(turn.untrusted).toBe(true);
  });

  it("keeps email out of the journal and the memory update", async () => {
    for (const r of [journalRoutine, consolidateRoutine]) {
      const turn = await run(r);
      expect(turn.prompt).toContain("T-3 Taxes");
      expect(turn.prompt).not.toContain("IBAN X");
      expect(turn.untrusted).toBeFalsy();
    }
  });
});
