import { notification } from "@hearth/db";
import { systemCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { ALL_MODULES } from "@hearth/modules";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkDisk, checkHealth, reportHealth } from "./health.ts";

let t: TestKernel;
beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
});
afterEach(() => t.destroy());

const opts = { dataDir: process.cwd() };
const report = (component: string, status = "ok") =>
  t.kernel.execute("system.report", { component, status, detail: "Running" }, systemCaller());

describe("health checks", () => {
  it("tells you directly when Jarvis stops checking in", async () => {
    await report("jarvis");
    expect(
      (await checkHealth(t.kernel, opts)).find((r) => r.component === "jarvis"),
    ).toBeUndefined();

    t.clock.advance(10 * 60_000);
    await reportHealth(t.kernel, await checkHealth(t.kernel, opts));
    await reportHealth(t.kernel, await checkHealth(t.kernel, opts));

    const changed = await t.events("system.health_changed");
    expect(
      changed.filter((e) => e.payload.component === "jarvis").map((e) => e.payload.status),
    ).toEqual(["ok", "failing"]);
    const notes = await t.kernel.db.select().from(notification);
    expect(notes.map((n) => n.title)).toEqual(["Jarvis is down"]);
  });

  it("flags a backup that hasn't run in a day and a half", async () => {
    await t.kernel.execute(
      "system.backup_finished",
      { ok: true, detail: "1.2 GB" },
      systemCaller(),
    );
    t.clock.advance(20 * 3_600_000);
    expect((await checkHealth(t.kernel, opts)).some((r) => r.component === "backup")).toBe(false);
    t.clock.advance(20 * 3_600_000);
    const stale = (await checkHealth(t.kernel, opts)).find((r) => r.component === "backup");
    expect(stale).toMatchObject({ status: "failing" });
    expect(stale?.detail).toContain("No backup since 2026-10-01");
  });

  it("also notices when local-only backups stop running", async () => {
    await report("backup", "degraded");
    t.clock.advance(40 * 3_600_000);
    const stale = (await checkHealth(t.kernel, opts)).find((r) => r.component === "backup");
    expect(stale).toMatchObject({ status: "failing" });
  });

  it("checks free disk space", async () => {
    const disk = await checkDisk(process.cwd());
    expect(["ok", "degraded", "failing"]).toContain(disk.status);
    expect(disk.detail).toMatch(/GB free/);
  });
});
