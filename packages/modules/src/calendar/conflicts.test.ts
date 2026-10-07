// Overlap notices: the same meeting on two of your accounts isn't one, a clash weeks away is told
// once it's two weeks out, two repeating meetings that clash are told once, not every week, a
// one-off that moves onto another week's meeting is told again, and one that's over by the time
// Jarvis gets to it isn't told at all.
import { calendar, entity } from "@hearth/db";
import { integrationCaller, type ReflexOutcome } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GEvent } from "../google/calendar-api.ts";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import { overlaps, WARN_DAYS } from "./conflicts.ts";

const ME = "owner@example.com";
const WORK = "work@example.com";
const DAY_MS = 24 * 3600_000;

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
});
afterEach(() => t.destroy());

const sync = async () => {
  const res = await t.kernel.execute("calendar.sync", {}, integrationCaller("google"));
  if (res.status !== "ok") throw new Error(JSON.stringify(res));
};
/** An hour's meeting `days` from now, at 3 p.m. UTC. */
function meeting(account: string, summary: string, days: number, more: Partial<GEvent> = {}) {
  const start = new Date(t.clock.now().getTime() + days * DAY_MS);
  start.setUTCHours(15, 0, 0, 0);
  const end = new Date(start.getTime() + 3600_000);
  g.put(account, {
    summary,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    ...more,
  });
  return start;
}
const ctx = () => ({ db: t.tdb.db, now: t.clock.now() }) as never;
/** What the reflex makes of every change the syncs saw. */
async function outcomes() {
  const out: ReflexOutcome[] = [];
  for (const e of await t.events("calendar.event_changed"))
    out.push(...(await overlaps.run(e, ctx())));
  return out;
}
/** The notices those come to, one per dedupe key, as the inbox keeps them. */
const told = (out: ReflexOutcome[]) => [
  ...new Set(out.flatMap((o) => (o.kind === "tell" ? [o.notification.dedupeKey] : []))),
];
const bodies = (out: ReflexOutcome[]) =>
  out.flatMap((o) => (o.kind === "tell" ? [o.notification.body] : []));

describe("overlap notices", () => {
  it("say when both are, ending on the time", async () => {
    meeting(ME, "Review", 2);
    meeting(ME, "Gym", 2);
    await sync();
    const out = await outcomes();
    expect(bodies(out)[0]).toMatch(/ to 12 p\.m\. and .* to 12 p\.m\.$/);
    // Hashed, however long Google's ids are.
    expect(told(out)).toEqual([expect.stringMatching(/^conflict:[0-9a-f]{32}$/)]);
  });

  it("don't call the same meeting on two of your accounts an overlap", async () => {
    const invite = { iCalUID: "planning-1@acme.example" };
    meeting(ME, "Planning", 2, invite);
    meeting(WORK, "Planning", 2, invite);
    await sync();
    expect(told(await outcomes())).toEqual([]);
    // A meeting of its own at that time overlaps it: one notice, not one per copy.
    meeting(WORK, "Dentist", 2);
    await sync();
    expect(told(await outcomes())).toHaveLength(1);
  });

  it("tell a clash weeks away once it's two weeks out", async () => {
    const start = meeting(ME, "Review", 30);
    meeting(ME, "Gym", 30);
    await sync();
    const out = await outcomes();
    expect(told(out)).toEqual([]);
    const check = out.find((o) => o.kind === "check_later" && o.key.startsWith("near:"));
    expect(check).toMatchObject({ at: new Date(start.getTime() - WARN_DAYS * DAY_MS) });
    if (check?.kind !== "check_later") throw new Error("no check");
    t.clock.set(check.at);
    expect(told(await overlaps.onCheck!(check.payload, ctx()))).toHaveLength(1);
  });

  it("let a check go for a meeting that moved since", async () => {
    meeting(ME, "Review", 30, { id: "review" });
    meeting(ME, "Gym", 30);
    await sync();
    const check = (await outcomes()).find((o) => o.kind === "check_later");
    if (check?.kind !== "check_later") throw new Error("no check");
    meeting(ME, "Review", 31, { id: "review" });
    await sync();
    t.clock.set(check.at);
    expect(await overlaps.onCheck!(check.payload, ctx())).toEqual([]);
  });

  it("tell two repeating meetings that clash once, not every week", async () => {
    for (const week of [0, 1, 2]) {
      meeting(ME, "Standup", 1 + 7 * week, {
        iCalUID: "standup@acme.example",
        recurringEventId: "standup",
      });
      meeting(ME, "1:1 with Sam", 1 + 7 * week, {
        iCalUID: "sam@acme.example",
        recurringEventId: "sam",
      });
    }
    await sync();
    const out = await outcomes();
    expect(told(out)).toHaveLength(1);
    // 3 p.m. UTC is 11 a.m. at home.
    expect(bodies(out)[0]).toMatch(/^Both repeat: every \w+day at 11 a\.m\.$/);
  });

  it("tell a one-off again when it moves onto another week's meeting", async () => {
    const weekly = { iCalUID: "sam@acme.example", recurringEventId: "sam" };
    meeting(ME, "1:1 with Sam", 2, weekly);
    meeting(ME, "1:1 with Sam", 9, weekly);
    meeting(ME, "Dentist", 2, { id: "dentist" });
    await sync();
    const first = told(await outcomes());
    expect(first).toHaveLength(1);
    meeting(ME, "Dentist", 9, { id: "dentist" });
    await sync();
    expect(told(await outcomes()).filter((k) => !first.includes(k))).toHaveLength(1);
  });

  it("let a check go for a meeting on a calendar you've turned off since", async () => {
    const team = "team@group.calendar.google.com";
    g.addCalendar({ id: team, summary: "Team", accessRole: "owner" });
    meeting(team, "Review", 30);
    meeting(ME, "Gym", 30);
    await sync();
    const [review] = await t.tdb.db.select().from(entity).where(eq(entity.title, "Review"));
    const check = (await outcomes()).find(
      (o) => o.kind === "check_later" && o.payload.eventId === review?.id,
    );
    if (check?.kind !== "check_later") throw new Error("no check");
    await t.tdb.db.update(calendar).set({ selected: false }).where(eq(calendar.googleId, team));
    t.clock.set(check.at);
    expect(await overlaps.onCheck!(check.payload, ctx())).toEqual([]);
  });

  it("leave out a clash that's over, though the longer meeting goes on", async () => {
    const day = new Date(t.clock.now().getTime() + DAY_MS).toISOString().slice(0, 10);
    const span = (summary: string, from: string, to: string) =>
      g.put(ME, {
        summary,
        start: { dateTime: `${day}T${from}:00Z` },
        end: { dateTime: `${day}T${to}:00Z` },
      });
    span("Offsite", "13:00", "22:00");
    span("Standup", "14:00", "14:30");
    await sync();
    t.clock.set(`${day}T16:00:00Z`);
    expect(told(await outcomes())).toEqual([]);
  });

  it("let a clash go that's over by the time Jarvis gets to it", async () => {
    meeting(ME, "Review", 1);
    meeting(WORK, "Gym", 1);
    await sync();
    // Jarvis was down for two days and catches up on the syncs now.
    t.clock.advance(2 * DAY_MS);
    expect(await outcomes()).toEqual([]);
  });
});
