// Real calls to Claude, so off unless HEARTH_LIVE_PROBE=1 (two cheap calls): every tool Jarvis
// sends is accepted, and a rejected one is named correctly from the API's "tools.N" (D54).
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { ALL_MODULES } from "@hearth/modules";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { probeToolSchemas } from "./probe.ts";

const live = process.env.HEARTH_LIVE_PROBE === "1";

describe.skipIf(!live)("the live model API", () => {
  let t: TestKernel;
  beforeAll(async () => {
    t = await createTestKernel(ALL_MODULES);
  });
  afterAll(() => t.destroy());

  it("accepts every tool Jarvis sends", async () => {
    const res = await probeToolSchemas(t.kernel);
    expect(res).toMatchObject({ ok: true });
    expect(res.tools).toBeGreaterThan(100);
  }, 180_000);

  it("rejects a bad tool by its place, which Hearth maps back to its name", async () => {
    // The pattern that took Jarvis down on 2026-10-04: a bare "[" inside a character class.
    const bad = {
      name: "probe_bad_tool",
      description: "A tool with a schema the API rejects.",
      input: z.object({ name: z.string().regex(/^[^[\]]+$/) }),
      run: async () => "unused",
    };
    const res = await probeToolSchemas(t.kernel, { extraTools: [bad] });
    expect(res).toMatchObject({ ok: false, failure: { kind: "bad_tool", tool: "probe_bad_tool" } });
  }, 180_000);
});
