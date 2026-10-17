// Finding a time with other people: your free working hours less their busy times, as Google's
// free/busy shows them to one of your accounts, and plainly who couldn't be checked.
import { integrationCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import type { Unseen } from "./find-time.ts";

const ME = "owner@example.com";
const WORK = "work@example.com";
const CAM = "cam@work.example";
/** Monday 9:00 in New York, when the owner's working day starts. */
const MONDAY = "2026-10-05T13:00:00Z";

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
  t.kernel.services[GOOGLE_SERVICE] = g.client(t.tdb.db);
  await signIn(ME);
  t.clock.advance(60_000);
  await signIn(WORK);
  // A colleague whose calendar your work account can see.
  g.colleagues.set(CAM, {
    busy: [{ start: "2026-10-05T14:00:00Z", end: "2026-10-05T16:00:00Z" }],
    seenBy: [WORK],
  });
  g.put(ME, {
    summary: "Dentist",
    start: { dateTime: "2026-10-05T18:00:00Z" },
    end: { dateTime: "2026-10-05T19:00:00Z" },
  });
  const synced = await t.kernel.execute("calendar.sync", {}, integrationCaller("google"));
  expect(synced.status).toBe("ok");
});
afterEach(() => t.destroy());

type Found = { slots: { start: string; end: string }[]; checked: string[]; unseen: Unseen[] };
const find = async (input: Record<string, unknown>) => {
  const res = await t.kernel.execute<Found>("calendar.find_time", input, ownerCaller());
  if (res.status !== "ok") throw new Error(JSON.stringify(res));
  return JSON.parse(JSON.stringify(res.result)) as Found;
};
const asked = () => g.calls.filter((c) => c.path.endsWith("/freeBusy"));

describe("calendar.find_time", () => {
  it("finds times you and your guests are all free, and says whose time it couldn't see", async () => {
    const r = await find({
      guests: [CAM, "ana@acme.example", "Work@Example.com"],
      minutes: 60,
      from: MONDAY,
      days: 1,
    });
    // 9 to 6 in New York, less Cam's 10 to 12 and your dentist at 2.
    expect(r.slots).toEqual([
      { start: "2026-10-05T13:00:00.000Z", end: "2026-10-05T14:00:00.000Z" },
      { start: "2026-10-05T16:00:00.000Z", end: "2026-10-05T18:00:00.000Z" },
      { start: "2026-10-05T19:00:00.000Z", end: "2026-10-05T22:00:00.000Z" },
    ]);
    expect(r.checked).toEqual([CAM]);
    expect(r.unseen).toEqual([
      { address: "ana@acme.example", why: expect.stringMatching(/isn't shared/) },
    ]);
    // Your work account is you, so it isn't asked about; each account is asked once.
    expect(
      asked().map((c) => (c.body as { items: { id: string }[] }).items.map((x) => x.id)),
    ).toEqual([
      [CAM, "ana@acme.example"],
      [CAM, "ana@acme.example"],
    ]);
  });

  it("asks Google nothing without guests, and says when Google couldn't be asked", async () => {
    const mine = await find({ minutes: 120, from: MONDAY, days: 1 });
    expect(mine.slots.map((s) => s.start)).toEqual([
      "2026-10-05T13:00:00.000Z",
      "2026-10-05T19:00:00.000Z",
    ]);
    expect(asked()).toEqual([]);
    g.failCalendar(2, 403);
    const r = await find({ guests: [CAM], minutes: 120, from: MONDAY, days: 1 });
    expect(r.unseen).toEqual([{ address: CAM, why: "Google couldn't be asked." }]);
    expect(r.slots).toEqual(mine.slots);
  });
});
