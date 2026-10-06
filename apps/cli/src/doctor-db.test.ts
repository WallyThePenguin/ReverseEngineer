import { randomUUID } from "node:crypto";
import { connect, jarvisTurn, loadMigrations } from "@hearth/db";
import { systemCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { ALL_MODULES } from "@hearth/modules";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Check } from "./doctor.ts";
import { checkDatabase, checkTurns } from "./doctor-db.ts";

let t: TestKernel;
beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
});
afterEach(() => t.destroy());

const find = (checks: Check[], name: string) => checks.find((c) => c.name === name);

describe("hearth doctor, what the database says", () => {
  it("fails a component that went quiet, even if its last word was ok", async () => {
    await t.kernel.execute(
      "system.report",
      { component: "worker", status: "ok", detail: "Running" },
      systemCaller(),
    );
    const fresh = await checkDatabase(t.tdb, t.clock.now());
    expect(find(fresh, "Database")?.mark).toBe("ok");
    expect(find(fresh, "Migrations")).toMatchObject({ mark: "ok" });
    expect(find(fresh, "worker")?.mark).toBe("ok");
    expect(find(fresh, "backup")?.mark).toBe("warn");

    t.clock.advance(10 * 60_000);
    const later = await checkDatabase(t.tdb, t.clock.now());
    expect(find(later, "worker")).toMatchObject({
      mark: "fail",
      detail: "No report for 10 min (last: Running).",
    });
  });

  it("fails Chrome's link when the server stopped reporting it", async () => {
    // The server reports it every 5 minutes; when the server is down, its last "Connected"
    // mustn't stay green next to the Server failure.
    await t.kernel.execute(
      "system.report",
      { component: "browser", status: "ok", detail: "Connected (extension 1.2.0)" },
      systemCaller(),
    );
    t.clock.advance(9 * 60_000);
    expect(find(await checkDatabase(t.tdb, t.clock.now()), "browser")?.mark).toBe("ok");
    t.clock.advance(2 * 60_000);
    expect(find(await checkDatabase(t.tdb, t.clock.now()), "browser")).toMatchObject({
      mark: "fail",
      detail: "No report for 11 min (last: Connected (extension 1.2.0)).",
    });
  });

  it("fails when Jarvis's turns keep failing", async () => {
    const turn = (status: "done" | "failed") => ({
      id: randomUUID(),
      trigger: "chat" as const,
      mode: "reactive" as const,
      lane: "fast" as const,
      origin: "owner" as const,
      prompt: "hi",
      status,
      error: status === "failed" ? "400 tools.124: invalid pattern" : null,
      // The failure is the latest.
      finishedAt: new Date(t.clock.now().getTime() - (status === "failed" ? 1 : 5) * 60_000),
    });
    await t.kernel.db.insert(jarvisTurn).values([turn("done"), turn("done"), turn("failed")]);
    const checks = await checkDatabase(t.tdb, t.clock.now());
    expect(find(checks, "Jarvis turns")).toMatchObject({
      mark: "fail",
      detail:
        "1 of 3 failed in the last 24 hours. Last error: 400 tools.124: invalid pattern Failures in 48 hours: chat/unknown x1.",
    });
  });

  it("stops at migrations that don't fit the code", async () => {
    const last = loadMigrations().at(-1)!.name;
    await t.tdb.pool.query("DELETE FROM _migration WHERE name = $1", [last]);
    const checks = await checkDatabase(t.tdb, t.clock.now());
    expect(checks.at(-1)).toMatchObject({ name: "Migrations", mark: "fail" });
    expect(checks.at(-1)?.detail).toContain(last);
  });

  it("says why it can't connect when Postgres isn't running", async () => {
    const nowhere = connect("postgres://hearth@localhost:1/hearth", { max: 1 });
    try {
      const [check] = await checkDatabase(nowhere, t.clock.now());
      expect(check).toMatchObject({ name: "Database", mark: "fail" });
      expect(check?.detail).toMatch(/^Can't connect: .*ECONNREFUSED/);
    } finally {
      await nowhere.close();
    }
  });

  it("judges a day of turns: a few failures warn, many fail", () => {
    const stats = (total: number, failed: number) => ({ total, failed, last: null });
    expect(checkTurns(stats(0, 0)).mark).toBe("ok");
    expect(checkTurns(stats(40, 0)).mark).toBe("ok");
    expect(checkTurns(stats(40, 2)).mark).toBe("warn");
    expect(checkTurns(stats(40, 5)).mark).toBe("fail");
  });

  it("says which turns failed and how, from counts alone", () => {
    const check = checkTurns({
      total: 5,
      failed: 2,
      last: null,
      failures48h: [
        { trigger: "routine", routine: "heartbeat", errorKind: "timeout", n: 2 },
        { trigger: "chat", routine: null, errorKind: null, n: 1 },
      ],
    });
    expect(check.detail).toBe(
      "2 of 5 failed in the last 24 hours. Failures in 48 hours: heartbeat/timeout x2, chat/unknown x1.",
    );
  });
});
