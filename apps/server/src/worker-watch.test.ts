import { notification } from "@hearth/db";
import { systemCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { ALL_MODULES } from "@hearth/modules";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type WorkerCheck, workerWatch } from "./worker-watch.ts";

let t: TestKernel;
beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
});
afterEach(() => t.destroy());

const checkIn = () =>
  t.kernel.execute(
    "system.report",
    { component: "worker", status: "ok", detail: "Running" },
    systemCaller(),
  );

/** The server's minute timer, `n` times: the last check's answer. */
async function minutes(check: () => Promise<WorkerCheck>, n: number) {
  let last: WorkerCheck = "never";
  for (let i = 0; i < n; i++) {
    t.clock.advance(60_000);
    last = await check();
  }
  return last;
}

describe("the server watching the worker", () => {
  it("tells you once per outage when the worker stops checking in", async () => {
    const check = workerWatch(t.kernel);
    expect(await check()).toBe("never");
    await checkIn();
    expect(await minutes(check, 4)).toBe("ok");
    expect(await minutes(check, 2)).toBe("told");
    expect(await minutes(check, 1)).toBe("already told");
    const told = await t.tdb.db.select().from(notification);
    expect(told).toMatchObject([
      { kind: "system.alert", title: "Hearth's worker has stopped", urgency: "interrupt" },
    ]);
    expect(told[0]?.body).toContain("since 2026-10-01 10 a.m.");

    // Back, then down again: a new outage, a new alert.
    await checkIn();
    expect(await check()).toBe("ok");
    expect(await minutes(check, 6)).toBe("told");
    expect(await t.tdb.db.select().from(notification)).toHaveLength(2);
  });

  it("gives the worker its few minutes after the PC wakes, as after a start", async () => {
    const check = workerWatch(t.kernel);
    await checkIn();
    expect(await check()).toBe("ok");
    // Asleep for two hours. On waking both timers are overdue, and the server's may run before
    // the worker has checked in: that's not an outage.
    t.clock.advance(2 * 3_600_000);
    expect(await check()).toBe("waiting");
    await checkIn();
    expect(await minutes(check, 3)).toBe("ok");
    expect(await t.tdb.db.select().from(notification)).toHaveLength(0);

    // A worker that doesn't come back after a sleep is still told about, once it's had its time.
    t.clock.advance(2 * 3_600_000);
    expect(await check()).toBe("waiting");
    expect(await minutes(check, 4)).toBe("waiting");
    expect(await minutes(check, 2)).toBe("told");
  });

  it("waits as long after the server starts, for a worker starting with it", async () => {
    await checkIn();
    t.clock.advance(30 * 60_000);
    // The server (re)started; the worker's last check-in is old, but it may be starting too.
    const check = workerWatch(t.kernel);
    expect(await check()).toBe("waiting");
    expect(await minutes(check, 4)).toBe("waiting");
    expect(await minutes(check, 2)).toBe("told");
  });
});
