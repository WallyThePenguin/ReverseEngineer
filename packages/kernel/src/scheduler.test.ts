import { DEFAULT_DAY_RULES, isValidTimeZone } from "@hearth/core";
import { schedule } from "@hearth/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDueSchedules, upsertSchedule } from "./scheduler.ts";
import { getSetting, setSetting } from "./settings.ts";
import { createTestKernel, type TestKernel } from "./testing.ts";

let t: TestKernel;
beforeAll(async () => {
  t = await createTestKernel([]);
});
afterAll(() => t.destroy());

const fired = async () => (await t.events("clock.fired")).map((e) => e.payload.scheduleId);

describe("scheduler", () => {
  it("fires a cron routine once per occurrence, in the owner's time zone", async () => {
    t.clock.set("2026-10-01T12:00:00Z"); // 8 a.m.
    await upsertSchedule(
      t.tdb.db,
      {
        id: "routine:brief",
        kind: "routine",
        cron: "15 8 * * *",
        payload: { routine: "assistant.brief" },
      },
      t.clock.now(),
    );
    expect(await runDueSchedules(t.tdb.db, t.clock)).toBe(0);
    t.clock.set("2026-10-01T12:15:30Z");
    expect(await runDueSchedules(t.tdb.db, t.clock)).toBe(1);
    expect(await runDueSchedules(t.tdb.db, t.clock)).toBe(0);
    const [row] = await t.tdb.db.select().from(schedule).where(eq(schedule.id, "routine:brief"));
    expect(row?.nextRunAt?.toISOString()).toBe("2026-10-02T12:15:00.000Z");
    const [e] = await t.events("clock.fired");
    expect(e?.payload).toMatchObject({
      scheduleId: "routine:brief",
      kind: "routine",
      routine: "assistant.brief",
      scheduledFor: "2026-10-01T12:15:00.000Z",
    });
    // Re-registering the same cron keeps the pending firing.
    await upsertSchedule(
      t.tdb.db,
      { id: "routine:brief", kind: "routine", cron: "15 8 * * *" },
      t.clock.now(),
    );
    const [same] = await t.tdb.db.select().from(schedule).where(eq(schedule.id, "routine:brief"));
    expect(same?.nextRunAt?.toISOString()).toBe("2026-10-02T12:15:00.000Z");
  });

  it("debounces a check: moving it later replaces the earlier time", async () => {
    t.clock.set("2026-10-01T15:00:00Z");
    await upsertSchedule(
      t.tdb.db,
      { id: "check:x", kind: "check", runAt: new Date("2026-10-01T15:10:00Z") },
      t.clock.now(),
    );
    await upsertSchedule(
      t.tdb.db,
      { id: "check:x", kind: "check", runAt: new Date("2026-10-01T15:20:00Z") },
      t.clock.now(),
    );
    t.clock.set("2026-10-01T15:15:00Z");
    expect(await runDueSchedules(t.tdb.db, t.clock)).toBe(0);
    t.clock.set("2026-10-01T15:21:00Z");
    expect(await runDueSchedules(t.tdb.db, t.clock)).toBe(1);
    expect(await runDueSchedules(t.tdb.db, t.clock)).toBe(0);
    expect((await fired()).filter((id) => id === "check:x")).toHaveLength(1);
  });

  it("skips a stale firing after the PC was off, and fires only once for the gap", async () => {
    t.clock.set("2026-10-01T09:00:00Z"); // 5 a.m.
    await upsertSchedule(
      t.tdb.db,
      { id: "routine:prep", kind: "routine", cron: "0 6 * * *", staleAfterSeconds: 2 * 3600 },
      t.clock.now(),
    );
    t.clock.set("2026-10-04T18:00:00Z"); // three days later, 2 p.m.
    await runDueSchedules(t.tdb.db, t.clock);
    expect(await fired()).not.toContain("routine:prep");
    const [row] = await t.tdb.db.select().from(schedule).where(eq(schedule.id, "routine:prep"));
    expect(row).toMatchObject({ lastOutcome: "skipped_stale" });
    expect(row?.nextRunAt?.toISOString()).toBe("2026-10-05T10:00:00.000Z");
  });

  it("keeps firing the rest when one schedule can't, and says why on that one", async () => {
    t.clock.set("2026-10-06T12:00:00Z");
    // Written straight to the table, as an old row or a hand edit could be: upsertSchedule
    // refuses a time zone like this.
    await t.tdb.db.insert(schedule).values({
      id: "routine:typo",
      kind: "routine",
      cron: "0 7 * * *",
      timeZone: "America/New York",
      nextRunAt: new Date("2026-10-06T11:00:00Z"),
    });
    await upsertSchedule(
      t.tdb.db,
      { id: "check:after", kind: "check", runAt: new Date("2026-10-06T11:30:00Z") },
      t.clock.now(),
    );
    const lines: string[] = [];
    // Every due row: the good ones fire, the bad one is set aside for an hour.
    const n = await runDueSchedules(t.tdb.db, t.clock, 50, (l) => lines.push(l));
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await fired()).toContain("check:after");
    const [bad] = await t.tdb.db.select().from(schedule).where(eq(schedule.id, "routine:typo"));
    expect(bad?.lastOutcome).toMatch(/^error: /);
    expect(bad?.nextRunAt?.toISOString()).toBe("2026-10-06T13:00:00.000Z");
    expect(lines).toEqual([expect.stringMatching(/^schedule routine:typo couldn't fire: /)]);
    expect(await runDueSchedules(t.tdb.db, t.clock)).toBe(0);
  });

  it("refuses a time zone it doesn't know, when a schedule or your day rules are saved", async () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("America/New York")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    await expect(
      upsertSchedule(
        t.tdb.db,
        { id: "routine:x", kind: "routine", cron: "0 7 * * *", timeZone: "Eastern" },
        t.clock.now(),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      setSetting(t.tdb.db, "owner.dayRules", { ...DEFAULT_DAY_RULES, timeZone: "EST5EDT x" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect((await getSetting(t.tdb.db, "owner.dayRules")).timeZone).toBe("America/New_York");
    await setSetting(t.tdb.db, "owner.dayRules", {
      ...DEFAULT_DAY_RULES,
      timeZone: "Europe/Paris",
    });
    expect((await getSetting(t.tdb.db, "owner.dayRules")).timeZone).toBe("Europe/Paris");
  });
});
