import { notification } from "@hearth/db";
import { systemCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { ALL_MODULES } from "@hearth/modules";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workerWatch } from "./worker-watch.ts";

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

describe("the server watching the worker", () => {
  it("tells you once per outage when the worker stops checking in", async () => {
    const check = workerWatch(t.kernel);
    expect(await check()).toBe("never");
    await checkIn();
    t.clock.advance(4 * 60_000);
    expect(await check()).toBe("ok");
    t.clock.advance(2 * 60_000);
    expect(await check()).toBe("told");
    expect(await check()).toBe("already told");
    const told = await t.tdb.db.select().from(notification);
    expect(told).toMatchObject([
      { kind: "system.alert", title: "Hearth's worker has stopped", urgency: "interrupt" },
    ]);
    expect(told[0]?.body).toContain("since 2026-10-01 10 a.m.");

    // Back, then down again: a new outage, a new alert.
    await checkIn();
    expect(await check()).toBe("ok");
    t.clock.advance(6 * 60_000);
    expect(await check()).toBe("told");
    expect(await t.tdb.db.select().from(notification)).toHaveLength(2);
  });
});
