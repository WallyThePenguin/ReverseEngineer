// "Slow" has a number: how long each action takes, in deep health, without what was asked.
import { afterEach, describe, expect, it } from "vitest";
import { ActionTimings } from "./action-timing.ts";
import type { DeepHealth } from "./deep-health.ts";
import { createTestServer, type TestServer } from "./testing/server.ts";

let t: TestServer | null = null;
afterEach(async () => {
  await t?.destroy();
  t = null;
});

describe("ActionTimings", () => {
  it("gives each action's count and percentiles, slowest first", () => {
    const timings = new ActionTimings();
    for (let ms = 1; ms <= 100; ms++) timings.record("mail.list", ms);
    timings.record("task.list", 3);
    timings.record("task.list", 5);
    expect(timings.slowest()).toEqual([
      { name: "mail.list", count: 100, p50: 50, p95: 95, max: 100 },
      { name: "task.list", count: 2, p50: 3, p95: 5, max: 5 },
    ]);
    expect(timings.slowest(1)).toHaveLength(1);
  });

  it("goes by recent runs, so a slow start fades while the count keeps growing", () => {
    const timings = new ActionTimings();
    for (let i = 0; i < 200; i++) timings.record("inbox.list", 900);
    for (let i = 0; i < 200; i++) timings.record("inbox.list", 10);
    expect(timings.slowest()[0]).toEqual({
      name: "inbox.list",
      count: 400,
      p50: 10,
      p95: 10,
      max: 10,
    });
  });
});

describe("in the server's log", () => {
  it("has each run over a second as it happens, and the whole table as the server stops", () => {
    const lines: string[] = [];
    const timings = new ActionTimings((line) => lines.push(line));
    timings.record("task.list", 40);
    timings.record("mail.sync", 1_234.4);
    expect(lines).toEqual(["Slow action: mail.sync took 1234 ms"]);
    timings.report();
    expect(lines[1]).toBe(
      "Action times since the server started (ms): mail.sync ×1 p50 1234 p95 1234 max 1234; task.list ×1 p50 40 p95 40 max 40",
    );
  });

  it("has nothing at a stop when nothing ran", () => {
    const lines: string[] = [];
    new ActionTimings((line) => lines.push(line)).report();
    expect(lines).toEqual([]);
  });
});

describe("in deep health", () => {
  it("lists the actions run since the server started, by name only", async () => {
    t = await createTestServer({ devAuth: true });
    const made = await t.browser("/api/actions/task.create", {
      method: "POST",
      json: { title: "Private errand" },
    });
    expect(made.status).toBe(200);
    // A name that isn't an action isn't kept.
    await t.browser("/api/actions/made.up", { method: "POST", json: {} });

    const res = await t.browser("/api/health/deep");
    const report = (await res.json()) as DeepHealth;
    expect(report.actions?.map((a) => [a.name, a.count])).toEqual([["task.create", 1]]);
    expect(JSON.stringify(report)).not.toContain("Private errand");
  });
});
