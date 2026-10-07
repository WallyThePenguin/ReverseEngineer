// A repeating meeting edited at Google: its occurrences from then on get new ids, and each keeps
// the row (and the prep on it) of the one it replaces, rather than being cancelled and added again.
import { randomBytes } from "node:crypto";
import { type Caller, integrationCaller, ownerCaller, type ReadContext } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import { newInvite } from "./invites.ts";
import type { EventView } from "./store.ts";

const ME = "owner@example.com";
const SAM = "sam@example.com";

let t: TestKernel;
let g: FakeGoogle;

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  t.clock.set("2026-10-01T12:00:00Z");
  g = new FakeGoogle(ME);
  g.clock = t.clock;
  g.grants = ["openid", "email", ...SCOPES.calendar];
  t.kernel.services[GOOGLE_SERVICE] = g.client();
  const client = g.client();
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.calendar]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
});
afterEach(() => t.destroy());

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const sync = () => ok("calendar.sync", {}, integrationCaller("google"));
const events = () =>
  ok<EventView[]>("calendar.events", { from: "2026-10-01T00:00:00Z", to: "2026-10-31T00:00:00Z" });
/** An occurrence of a repeating meeting, as Google lists it: `series` plus when it was due. */
function weekly(summary: string, series: string, day: string, hour: number, extra = {}) {
  const start = `2026-10-${day}T${String(hour).padStart(2, "0")}:00:00Z`;
  g.put(ME, {
    id: `${series}_${start.replace(/[-:]/g, "").slice(0, 15)}Z`,
    summary,
    recurringEventId: series,
    iCalUID: `${series}@google.com`,
    organizer: { email: ME, self: true },
    start: { dateTime: start },
    end: { dateTime: start.replace(":00:00Z", ":30:00Z") },
    ...extra,
  });
}
/** Sam's meeting, with your answer to it. */
const fromSam = (responseStatus: "accepted" | "needsAction") => ({
  organizer: { email: SAM },
  attendees: [
    { email: SAM, organizer: true, responseStatus: "accepted" },
    { email: ME, self: true, responseStatus },
  ],
});
const read = (): ReadContext => ({ db: t.tdb.db, now: t.clock.now() });
const at = (list: EventView[], day: string) =>
  list.find((e) => e.startsAt.toISOString().startsWith(`2026-10-${day}`))!;
const changes = async (since: number) =>
  (await t.events("calendar.event_changed")).slice(since).map((e) => e.payload.change);

describe("a repeating meeting edited at Google", () => {
  it("keeps its rows, prep and all, when this and the following ones move", async () => {
    for (const day of ["05", "12", "19"]) weekly("Standup", "standup", day, 14);
    await sync();
    const before = await events();
    await ok("prep.publish", { eventId: at(before, "12").id, markdown: "Bring the numbers." });
    const seen = (await t.events("calendar.event_changed")).length;
    // From the 12th, an hour later: Google splits off a new series with new ids.
    g.remove(ME, "standup_20261012T140000Z");
    g.remove(ME, "standup_20261019T140000Z");
    // Listed in no particular order.
    for (const day of ["19", "12"]) weekly("Standup", "standup_R20261012T150000", day, 15);
    await sync();
    const after = await events();
    expect(after.map((e) => [e.id, e.startsAt.toISOString()])).toEqual([
      [before[0]!.id, "2026-10-05T14:00:00.000Z"],
      [before[1]!.id, "2026-10-12T15:00:00.000Z"],
      [before[2]!.id, "2026-10-19T15:00:00.000Z"],
    ]);
    expect(after[1]?.prepId).toBeTruthy();
    expect(await changes(seen)).toEqual(["updated", "updated"]);
  });

  it("doesn't take another meeting that day for it", async () => {
    weekly("Standup", "standup", "12", 14);
    await sync();
    const [standup] = await events();
    g.remove(ME, "standup_20261012T140000Z");
    weekly("Yoga", "yoga", "12", 14);
    await sync();
    const [yoga] = await events();
    expect(yoga).toMatchObject({ title: "Yoga" });
    expect(yoga?.id).not.toBe(standup?.id);
  });

  it("keeps the prep when the meeting moves to another weekday", async () => {
    for (const day of ["05", "12", "19"]) weekly("Standup", "standup", day, 14);
    await sync();
    const before = await events();
    await ok("prep.publish", { eventId: at(before, "12").id, markdown: "Bring the numbers." });
    // From the 12th on, Tuesdays instead of Mondays.
    g.remove(ME, "standup_20261012T140000Z");
    g.remove(ME, "standup_20261019T140000Z");
    for (const day of ["13", "20"]) weekly("Standup", "standup_R20261013T140000", day, 14);
    await sync();
    const after = await events();
    expect(after.map((e) => [e.id, e.startsAt.toISOString()])).toEqual([
      [before[0]!.id, "2026-10-05T14:00:00.000Z"],
      [before[1]!.id, "2026-10-13T14:00:00.000Z"],
      [before[2]!.id, "2026-10-20T14:00:00.000Z"],
    ]);
    expect(after[1]?.prepId).toBeTruthy();
  });

  it("gives each a day the row of its own day, closest first, when it moves past midnight", async () => {
    for (const day of ["05", "06", "07"]) weekly("Check-in", "checkin", day, 23);
    await sync();
    const before = await events();
    const seen = (await t.events("calendar.event_changed")).length;
    // All of them an hour later, listed last first: each is within reach of two old ones.
    for (const day of ["05", "06", "07"]) g.remove(ME, `checkin_202610${day}T230000Z`);
    for (const day of ["08", "07", "06"]) weekly("Check-in", "checkin", day, 0);
    await sync();
    const after = await events();
    expect(after.map((e) => [e.id, e.startsAt.toISOString()])).toEqual([
      [before[0]!.id, "2026-10-06T00:00:00.000Z"],
      [before[1]!.id, "2026-10-07T00:00:00.000Z"],
      [before[2]!.id, "2026-10-08T00:00:00.000Z"],
    ]);
    expect(await changes(seen)).toEqual(["updated", "updated", "updated"]);
  });

  it("asks you again, with an invitation card, when the organizer's change wants a new answer", async () => {
    const sam = await ok<{ id: string }>("person.create", { name: "Sam" });
    await ok("person.add_email", { id: sam.id, email: SAM });
    for (const day of ["05", "12", "19"]) weekly("Planning", "plan", day, 14, fromSam("accepted"));
    await sync();
    const before = await events();
    const seen = (await t.events("calendar.event_changed")).length;
    // Sam moves it an hour from the 12th on, and Google asks the guests again.
    g.remove(ME, "plan_20261012T140000Z");
    g.remove(ME, "plan_20261019T140000Z");
    for (const day of ["12", "19"])
      weekly("Planning", "plan_R20261012T150000", day, 15, fromSam("needsAction"));
    await sync();
    expect((await events()).map((e) => e.id)).toEqual(before.map((e) => e.id));
    const told = (await t.events("calendar.event_changed")).slice(seen);
    expect(told.map((e) => e.payload.change)).toEqual(["added", "added"]);
    const first = told.find((e) => e.entityId === at(before, "12").id)!;
    // From Sam, whom you know, and you're free: Jarvis says yes again (D71), and the invitation
    // card goes out instead should it find it can't.
    const card = {
      kind: "act",
      action: "calendar.respond",
      input: { id: at(before, "12").id, response: "accepted", scope: "all" },
      ask: expect.stringContaining(`From ${SAM}.`),
    };
    expect(await newInvite.run(first, read())).toMatchObject([
      {
        kind: "act",
        action: "calendar.accept_invite",
        input: { id: at(before, "12").id },
        fallback: [card],
      },
    ]);
  });

  it("keeps the old row when the one taking it over won't save", async () => {
    weekly("Standup", "standup", "12", 14);
    await sync();
    const [before] = await events();
    g.remove(ME, "standup_20261012T140000Z");
    // A UID too long for its index: Postgres refuses the row.
    const iCalUID = `${randomBytes(6000).toString("base64url")}@x.example`;
    weekly("Standup", "standup_R20261012T150000", "12", 15, { iCalUID });
    expect(await sync()).toMatchObject({ failed: [], skipped: 1 });
    expect(await events()).toMatchObject([{ id: before?.id, status: "confirmed" }]);
  });
});
