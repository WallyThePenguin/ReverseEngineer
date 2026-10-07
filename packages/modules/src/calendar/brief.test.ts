// The calendar's lines in the morning brief and the evening journal, and the evening card's look
// at tomorrow: today's meetings and all-day events, never tomorrow's all-day ones, and never the
// entries Google adds by itself to say where you work or whose birthday it is.
import { addLocalDays, atLocal } from "@hearth/core";
import { calendarEvent } from "@hearth/db";
import { getSetting, integrationCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tomorrowAtAGlance } from "../assistant/wrap.ts";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import { calendarModule } from "./index.ts";

const ME = "owner@example.com";
const TODAY = "2026-10-07";
const TOMORROW = addLocalDays(TODAY, 1);

let t: TestKernel;
let g: FakeGoogle;
let tz: string;

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(ME);
  g.clock = t.clock;
  t.kernel.services[GOOGLE_SERVICE] = g.client(t.tdb.db);
  const client = g.client(t.tdb.db);
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.calendar]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
  ({ timeZone: tz } = await getSetting(t.tdb.db, "owner.dayRules"));
});
afterEach(() => t.destroy());

const sync = async () => {
  const res = await t.kernel.execute("calendar.sync", {}, integrationCaller("google"));
  if (res.status !== "ok") throw new Error(JSON.stringify(res));
};
const allDay = (summary: string, day: string, eventType?: string) =>
  g.put(ME, {
    summary,
    start: { date: day },
    end: { date: addLocalDays(day, 1) },
    transparency: "transparent",
    ...(eventType ? { eventType } : {}),
  });
const timed = (summary: string, day: string, hour: number, eventType?: string) =>
  g.put(ME, {
    summary,
    start: { dateTime: atLocal(day, hour * 60, tz).toISOString() },
    end: { dateTime: atLocal(day, hour * 60 + 30, tz).toISOString() },
    ...(eventType ? { eventType } : {}),
  });
/** The calendar's lines in the digest the brief and the journal are written from, at `hour`. */
async function lines(hour: number) {
  t.clock.set(atLocal(TODAY, hour * 60, tz));
  const items = await calendarModule.digest!({
    db: t.tdb.db,
    now: t.clock.now(),
    since: t.clock.now(),
  });
  return items.filter((i) => i.bucket === "today").map((i) => i.text);
}

beforeEach(async () => {
  t.clock.set(atLocal(TODAY, 6 * 60, tz));
  allDay("Offsite", TODAY);
  allDay("Ana's birthday", TODAY, "birthday");
  allDay("Home", TODAY, "workingLocation");
  timed("Office", TODAY, 13, "workingLocation");
  timed("Standup", TODAY, 10);
  allDay("Conference", TOMORROW);
  timed("Planning", TOMORROW, 9);
  timed("Office", TOMORROW, 8, "workingLocation");
  await sync();
});

describe("the brief and the journal", () => {
  it("list today's all-day events and meetings, but not tomorrow's all-day ones", async () => {
    // The brief at 7 a.m., and the journal at 7:30 p.m., when tomorrow is under 24 hours away.
    expect(await lines(7)).toEqual(["Offsite (all day)", expect.stringMatching(/ Standup$/)]);
    expect(await lines(19.5)).toEqual(["Offsite (all day)"]);
  });

  it("leave out where you work and birthdays, even on rows saved before Hearth kept kinds", async () => {
    // As the rows were before 0048: every one "default", unchanged at Google since.
    await t.tdb.db.update(calendarEvent).set({ kind: "default" });
    expect(await lines(7)).toContain("Home (all day)");
    await sync();
    expect(await lines(7)).toEqual(["Offsite (all day)", expect.stringMatching(/ Standup$/)]);
  });
});

describe("the evening card", () => {
  it("starts tomorrow with its first meeting, not where you'll work", async () => {
    const card = await tomorrowAtAGlance(t.tdb.db, TODAY, tz);
    expect(card).toMatch(/^Tomorrow: 9 a\.m\. Planning$/m);
    expect(card).not.toContain("Office");
  });
});
