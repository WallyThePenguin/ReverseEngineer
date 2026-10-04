import { tmpdir } from "node:os";
import { notification } from "@hearth/db";
import { ownerCaller, systemCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { ALL_MODULES, type JudgedHealth } from "@hearth/modules";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkDisk,
  checkDisks,
  checkDrives,
  checkHealth,
  diskStatus,
  hearthFolders,
  reportHealth,
} from "./health.ts";

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

  it("judges free space in gigabytes, so a big drive isn't failing at 1%", () => {
    const GB = 1024 ** 3;
    expect(diskStatus(1.5 * GB)).toBe("failing");
    expect(diskStatus(9.8 * GB)).toBe("degraded");
    expect(diskStatus(18 * GB)).toBe("ok");
  });

  it("checks every drive Hearth uses once, by name", async () => {
    const drives = await checkDrives([process.cwd(), process.cwd(), tmpdir(), "Z:\\nowhere"]);
    expect(drives.length).toBeGreaterThanOrEqual(1);
    expect(new Set(drives.map((d) => d.drive)).size).toBe(drives.length);
    if (process.platform === "win32") expect(drives[0]!.drive).toMatch(/^[A-Z]:$/);
    const disk = await checkDisks([process.cwd(), tmpdir()]);
    expect(disk.detail).toContain(`${drives[0]!.drive} `);
    // The system drive is watched even when Hearth's data is elsewhere.
    expect(hearthFolders("D:\\Hearth\\data", { SystemDrive: "C:" })).toContain("C:\\");
  });

  it("shows a component that stopped reporting as failing", async () => {
    await report("worker");
    const components = async () => {
      const res = await t.kernel.execute<{ components: Record<string, JudgedHealth> }>(
        "system.status",
        {},
        ownerCaller("ui"),
      );
      if (res.status !== "ok") throw new Error(JSON.stringify(res));
      return res.result.components;
    };
    t.clock.advance(90_000);
    expect((await components()).worker).toMatchObject({ status: "ok", stale: false });
    t.clock.advance(60_000);
    const worker = (await components()).worker!;
    expect(worker).toMatchObject({ status: "failing", stale: true });
    expect(worker.detail).toBe("No report for 3 min (last: Running).");
  });
});
