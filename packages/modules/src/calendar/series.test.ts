// A repeating meeting edited at Google: its occurrences from then on get new ids, and each keeps
// the row (and the prep on it) of the one it replaces, rather than being cancelled and added again.
import { type Caller, integrationCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import type { EventView } from "./store.ts";

const ME = "owner@example.com";

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
/** An occurrence of a weekly meeting, as Google lists it: `series` plus when it was due. */
function weekly(summary: string, series: string, day: string, hour: number) {
  const start = `2026-10-${day}T${String(hour).padStart(2, "0")}:00:00Z`;
  g.put(ME, {
    id: `${series}_${start.replace(/[-:]/g, "").slice(0, 15)}Z`,
    summary,
    recurringEventId: series,
    iCalUID: `${series}@google.com`,
    organizer: { email: ME, self: true },
    start: { dateTime: start },
    end: { dateTime: start.replace(":00:00Z", ":30:00Z") },
  });
}
const changes = async (since: number) =>
  (await t.events("calendar.event_changed")).slice(since).map((e) => e.payload.change);

describe("a repeating meeting edited at Google", () => {
  it("keeps its rows, prep and all, when this and the following ones move", async () => {
    for (const day of ["05", "12", "19"]) weekly("Standup", "standup", day, 14);
    await sync();
    const before = await events();
    const oct12 = before.find((e) => e.startsAt.toISOString().startsWith("2026-10-12"))!;
    await ok("prep.publish", { eventId: oct12.id, markdown: "Bring the numbers." });
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
});
