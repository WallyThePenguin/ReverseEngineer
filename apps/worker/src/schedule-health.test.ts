import { schedule } from "@hearth/db";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { ALL_MODULES } from "@hearth/modules";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSchedules, scheduleWatch } from "./schedule-health.ts";

let t: TestKernel;
beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
});
afterEach(() => t.destroy());

const at = (iso: string) => new Date(iso);

describe("schedule health", () => {
  it("is ok while schedules are on time, and gives a fresh worker time to catch up", async () => {
    const up = t.kernel.clock.now();
    await t.tdb.db.insert(schedule).values({
      id: "routine:assistant.brief",
      kind: "routine",
      cron: "15 8 * * *",
      nextRunAt: at("2026-10-01T13:30:00Z"), // half an hour ago
    });
    expect(await checkSchedules(t.kernel, up)).toEqual({
      component: "schedules",
      status: "ok",
      detail: "Catching up",
    });
    t.clock.advance(11 * 60_000);
    const late = await checkSchedules(t.kernel, up);
    expect(late.status).toBe("failing");
    expect(late.detail).toMatch(/^A schedule is overdue, the oldest since 2026-10-01 9:30 a\.m\./);

    await t.tdb.db
      .update(schedule)
      .set({ nextRunAt: at("2026-10-02T12:15:00Z"), lastOutcome: "fired" })
      .where(eq(schedule.id, "routine:assistant.brief"));
    expect(await checkSchedules(t.kernel, up)).toMatchObject({ status: "ok", detail: "On time" });
  });

  it("names a schedule that can't fire", async () => {
    await t.tdb.db.insert(schedule).values({
      id: "routine:typo",
      kind: "routine",
      cron: "0 7 * * *",
      timeZone: "America/New York",
      nextRunAt: at("2026-10-01T15:00:00Z"),
      lastOutcome: "error: Invalid time zone",
    });
    expect(await checkSchedules(t.kernel, t.kernel.clock.now())).toEqual({
      component: "schedules",
      status: "failing",
      detail: "routine:typo can't run: Invalid time zone. Nook tries again every hour.",
    });
  });

  it("gives the scheduler time to catch up after the PC wakes, as after a start", async () => {
    const watch = scheduleWatch(t.kernel, 60_000);
    // The brief was due at 8:15; the PC slept from 2 a.m. until now (10 a.m.).
    await t.tdb.db.insert(schedule).values({
      id: "routine:assistant.brief",
      kind: "routine",
      cron: "15 8 * * *",
      nextRunAt: at("2026-10-01T12:15:00Z"),
    });
    expect((await watch()).status).toBe("ok");
    // Awake for good, a check a minute: after ten minutes it counts as overdue.
    for (let i = 0; i < 11; i++) {
      t.clock.advance(60_000);
      await watch();
    }
    expect((await watch()).status).toBe("failing");
    // Asleep again for hours: on waking, the first check doesn't call it stuck.
    t.clock.advance(3 * 3_600_000);
    expect(await watch()).toMatchObject({ status: "ok", detail: "Catching up" });
  });
});
