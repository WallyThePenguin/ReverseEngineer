// Answering invitations (6.7): only your own answer changes, and a repeating meeting is answered
// for this time or every time.
import { calendarEvent, entity } from "@hearth/db";
import { integrationCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GAttendee } from "../google/calendar-api.ts";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";

const ME = "owner@example.com";
const BOSS = "boss@work.example";

let t: TestKernel;
let g: FakeGoogle;

const guests = (): GAttendee[] => [
  { email: BOSS, organizer: true, responseStatus: "accepted" },
  { email: "ana@work.example", responseStatus: "tentative", optional: true, comment: "Late" },
  { email: ME, self: true, responseStatus: "needsAction" },
];
const weekly = (day: string) => ({
  id: `wk_${day.replace(/-/g, "")}T150000Z`,
  recurringEventId: "wk",
  summary: "Weekly sync",
  organizer: { email: BOSS },
  attendees: guests(),
  start: { dateTime: `${day}T15:00:00Z` },
  end: { dateTime: `${day}T16:00:00Z` },
});

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(ME);
  g.clock = t.clock;
  t.kernel.services[GOOGLE_SERVICE] = g.client(t.tdb.db);
  const client = g.client(t.tdb.db);
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.calendar]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
  // The series itself started months ago; its times in the window are what sync sees.
  g.put(ME, { ...weekly("2026-08-03"), id: "wk", recurringEventId: undefined });
  g.put(ME, weekly("2026-10-05"));
  g.put(ME, weekly("2026-10-12"));
  await t.kernel.execute("calendar.sync", {}, integrationCaller("google"));
});
afterEach(() => t.destroy());

const times = async () =>
  (
    await t.tdb.db
      .select({
        googleId: calendarEvent.googleId,
        response: calendarEvent.selfResponse,
        id: entity.id,
      })
      .from(calendarEvent)
      .innerJoin(entity, eq(entity.id, calendarEvent.entityId))
  ).sort((a, b) => a.googleId.localeCompare(b.googleId));
const respond = (input: Record<string, unknown>) =>
  t.kernel.execute("calendar.respond", input, ownerCaller());
const lastPatch = () => g.calls.filter((c) => c.method === "PATCH").at(-1)!;

describe("answering a repeating meeting", () => {
  it("asks whether the answer is for this time or every time", async () => {
    const [first] = await times();
    const res = await respond({ id: first!.id, response: "accepted" });
    expect(res).toMatchObject({ status: "error", code: "invalid_input" });
    expect(JSON.stringify(res)).toContain("This meeting repeats");
    expect(g.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("answers the series for every time, changing only your own answer", async () => {
    const [first] = await times();
    expect(await respond({ id: first!.id, response: "accepted", scope: "all" })).toMatchObject({
      status: "ok",
    });
    const patch = lastPatch();
    expect(patch.path).toMatch(/\/events\/wk$/);
    expect(patch.body).toEqual({
      attendees: [
        { email: BOSS, organizer: true, responseStatus: "accepted" },
        { email: "ana@work.example", responseStatus: "tentative", optional: true, comment: "Late" },
        { email: ME, self: true, responseStatus: "accepted" },
      ],
    });
    expect((await times()).map((x) => x.response)).toEqual(["accepted", "accepted"]);
  });

  it("answers one time on its own", async () => {
    const [first, second] = await times();
    await respond({ id: first!.id, response: "accepted", scope: "all" });
    expect(await respond({ id: second!.id, response: "declined", scope: "this" })).toMatchObject({
      status: "ok",
    });
    expect(lastPatch().path).toMatch(/\/events\/wk_20261012T150000Z$/);
    expect((await times()).map((x) => x.response)).toEqual(["accepted", "declined"]);
  });
});
