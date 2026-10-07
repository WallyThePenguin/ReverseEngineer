// Several Google accounts at once (D61): each syncs its own calendars, a calendar they share is
// synced through one of them, and new events go where Settings says.
import { calendar, calendarEvent, entity } from "@hearth/db";
import { integrationCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GAttendee } from "../google/calendar-api.ts";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import { busyTimes } from "./free.ts";
import type { SyncResult } from "./sync.ts";

const ME = "owner@example.com";
const WORK = "work@example.com";
const HOLIDAYS = "en.usa#holiday@group.v.calendar.google.com";

let t: TestKernel;
let g: FakeGoogle;

async function signIn(email: string) {
  g.signingIn = email;
  const client = g.client(t.tdb.db);
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.calendar]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
}

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(ME);
  g.clock = t.clock;
  g.addAccount(WORK);
  g.shareCalendar({ id: HOLIDAYS, summary: "Holidays" }, { [ME]: "reader", [WORK]: "reader" });
  t.kernel.services[GOOGLE_SERVICE] = g.client(t.tdb.db);
  await signIn(ME);
  t.clock.advance(60_000);
  await signIn(WORK);
});
afterEach(() => t.destroy());

const run = async <T>(action: string, input: unknown = {}) => {
  const res = await t.kernel.execute<T>(action, input, ownerCaller());
  if (res.status !== "ok") throw new Error(JSON.stringify(res));
  return res.result;
};
const sync = async () => {
  const res = await t.kernel.execute<SyncResult>("calendar.sync", {}, integrationCaller("google"));
  if (res.status !== "ok") throw new Error(JSON.stringify(res));
  return res.result;
};
const at = (iso: string) => ({ dateTime: iso });
const rowOf = async (account: string, googleId: string) => {
  const [row] = await t.tdb.db
    .select()
    .from(calendar)
    .where(and(eq(calendar.account, account), eq(calendar.googleId, googleId)));
  if (!row) throw new Error(`No calendar ${googleId} for ${account}`);
  return row;
};
const events = async () =>
  (
    await t.tdb.db
      .select({ title: entity.title, account: calendar.account })
      .from(calendarEvent)
      .innerJoin(entity, eq(entity.id, calendarEvent.entityId))
      .innerJoin(calendar, eq(calendar.id, calendarEvent.calendarId))
  ).sort((a, b) => a.title.localeCompare(b.title));

describe("two Google accounts", () => {
  it("both sync, and a calendar they share is synced once", async () => {
    g.put(ME, {
      summary: "Dentist",
      start: at("2026-10-02T14:00:00Z"),
      end: at("2026-10-02T15:00:00Z"),
    });
    g.put(WORK, {
      summary: "Standup",
      start: at("2026-10-02T13:00:00Z"),
      end: at("2026-10-02T13:15:00Z"),
    });
    g.put(HOLIDAYS, {
      summary: "Columbus Day",
      start: { date: "2026-10-12" },
      end: { date: "2026-10-13" },
    });

    // Each account has its own row for the holiday calendar; shared ones start off.
    expect(await sync()).toMatchObject({ failed: [], calendars: 2, events: 2 });
    expect((await rowOf(ME, HOLIDAYS)).selected).toBe(false);
    expect((await rowOf(WORK, HOLIDAYS)).selected).toBe(false);
    expect(await events()).toEqual([
      { title: "Dentist", account: ME },
      { title: "Standup", account: WORK },
    ]);

    // Turned on through one account; the other can't sync it too.
    await run("calendar.choose", { id: (await rowOf(ME, HOLIDAYS)).id, selected: true });
    const twice = await t.kernel.execute(
      "calendar.choose",
      { id: (await rowOf(WORK, HOLIDAYS)).id, selected: true },
      ownerCaller(),
    );
    expect(twice).toMatchObject({ status: "error", code: "conflict" });
    expect(JSON.stringify(twice)).toContain(`already syncs through ${ME}`);

    expect(await sync()).toMatchObject({ failed: [], calendars: 3, events: 3 });
    expect(await events()).toEqual([
      { title: "Columbus Day", account: ME },
      { title: "Dentist", account: ME },
      { title: "Standup", account: WORK },
    ]);

    // Gone from Google is gone here, through the account that syncs it.
    g.remove(HOLIDAYS, [...g.calendars.get(HOLIDAYS)!.events.keys()][0]!);
    await sync();
    const [holiday] = await t.tdb.db
      .select({ status: calendarEvent.status })
      .from(calendarEvent)
      .innerJoin(entity, eq(entity.id, calendarEvent.entityId))
      .where(eq(entity.title, "Columbus Day"));
    expect(holiday?.status).toBe("cancelled");
  });

  it("syncs a calendar both accounts own through the first one only", async () => {
    g.shareCalendar({ id: "team", summary: "Team" }, { [ME]: "owner", [WORK]: "owner" });
    g.put("team", {
      summary: "Retro",
      start: at("2026-10-02T18:00:00Z"),
      end: at("2026-10-02T19:00:00Z"),
    });
    await sync();
    expect((await rowOf(ME, "team")).selected).toBe(true);
    expect((await rowOf(WORK, "team")).selected).toBe(false);
    expect((await events()).filter((e) => e.title === "Retro")).toEqual([
      { title: "Retro", account: ME },
    ]);
  });

  it("hands a shared calendar to the other account when the one syncing it is disconnected", async () => {
    g.shareCalendar({ id: "team", summary: "Team" }, { [ME]: "owner", [WORK]: "owner" });
    g.put("team", {
      summary: "Retro",
      start: at("2026-10-02T18:00:00Z"),
      end: at("2026-10-02T19:00:00Z"),
    });
    await sync();
    await run("calendar.set_default", { id: (await rowOf(ME, "team")).id });
    await run("google.disconnect", { email: ME });
    // The work account has it now, and new events still go there.
    expect(await rowOf(WORK, "team")).toMatchObject({ selected: true, writeDefault: true });
    await sync();
    expect(await events()).toEqual([{ title: "Retro", account: WORK }]);
  });

  it("hands a shared calendar to the other account when the one syncing it leaves it", async () => {
    g.shareCalendar({ id: "team", summary: "Team" }, { [ME]: "owner", [WORK]: "owner" });
    g.put("team", {
      summary: "Retro",
      start: at("2026-10-02T18:00:00Z"),
      end: at("2026-10-02T19:00:00Z"),
    });
    await sync();
    expect(await rowOf(ME, "team")).toMatchObject({ selected: true });
    g.accounts.get(ME)!.calendars.delete("team");
    await sync();
    await sync();
    expect(await rowOf(WORK, "team")).toMatchObject({ selected: true });
    expect(await events()).toEqual([{ title: "Retro", account: WORK }]);
  });

  it("leaves a calendar you turned off out of your busy time", async () => {
    g.shareCalendar({ id: "ana", summary: "Ana" }, { [ME]: "reader" });
    g.put("ana", {
      summary: "Ana's dentist",
      start: at("2026-10-02T15:00:00Z"),
      end: at("2026-10-02T16:00:00Z"),
    });
    await sync();
    const ana = await rowOf(ME, "ana");
    await run("calendar.choose", { id: ana.id, selected: true });
    await sync();
    const window = [new Date("2026-10-02T00:00:00Z"), new Date("2026-10-03T00:00:00Z")] as const;
    expect(await busyTimes(t.tdb.db, ...window)).toHaveLength(1);
    // Turned off, its events stay on this PC, but they aren't your time any more.
    await run("calendar.choose", { id: ana.id, selected: false });
    expect(await busyTimes(t.tdb.db, ...window)).toEqual([]);
  });

  it("lists a meeting you're invited to at both addresses once, as the copy you said yes to", async () => {
    const planning = (self: string, response: GAttendee["responseStatus"], day: string) => ({
      summary: "Planning",
      iCalUID: "planning-1@google.com",
      start: at(`2026-10-${day}T16:00:00Z`),
      end: at(`2026-10-${day}T17:00:00Z`),
      attendees: [
        { email: "ana@example.com", organizer: true, responseStatus: "accepted" as const },
        { email: self, self: true, responseStatus: response },
      ],
    });
    g.put(ME, planning(ME, "declined", "02"));
    g.put(WORK, planning(WORK, "accepted", "02"));
    // A later time of the same repeating meeting has its iCalUID, but not its start.
    g.put(ME, planning(ME, "needsAction", "09"));
    await sync();
    const listed = await run<{ title: string; startsAt: Date; selfResponse: string | null }[]>(
      "calendar.events",
      { from: "2026-10-01T00:00:00Z", to: "2026-10-12T00:00:00Z" },
    );
    expect(
      listed
        .filter((e) => e.title === "Planning")
        .map((e) => [new Date(e.startsAt).toISOString(), e.selfResponse]),
    ).toEqual([
      ["2026-10-02T16:00:00.000Z", "accepted"],
      ["2026-10-09T16:00:00.000Z", "needsAction"],
    ]);
  });

  it("puts new events on the calendar you chose", async () => {
    await sync();
    const setup = await run<{
      calendars: { id: string; account: string; writeDefault: boolean }[];
    }>("calendar.calendars");
    // Until you choose, it's the first account's own calendar.
    expect(setup.calendars.filter((c) => c.writeDefault)).toMatchObject([{ account: ME }]);
    const work = await rowOf(WORK, WORK);
    await run("calendar.set_default", { id: work.id });
    await run("calendar.create_event", {
      title: "Focus",
      start: "2026-10-05T14:00:00Z",
      end: "2026-10-05T15:00:00Z",
    });
    expect([...g.accounts.get(WORK)!.calendars.get(WORK)!.events.values()]).toMatchObject([
      { summary: "Focus" },
    ]);
    expect(g.calendars.get(ME)!.events.size).toBe(0);
    expect(await events()).toEqual([{ title: "Focus", account: WORK }]);
    // A calendar Hearth can't write to can't be the one.
    const refused = await t.kernel.execute(
      "calendar.set_default",
      { id: (await rowOf(ME, HOLIDAYS)).id },
      ownerCaller(),
    );
    expect(refused).toMatchObject({ status: "error", code: "not_found" });
  });
});
