// Overlap notices: the same meeting on two of your accounts isn't one, a clash weeks away is told
// once it's two weeks out, two repeating meetings that clash are told once, not every week, and
// one that's over by the time Jarvis gets to it isn't told at all.
import { integrationCaller, type ReflexOutcome } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GEvent } from "../google/calendar-api.ts";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import { conflicts, WARN_DAYS } from "./conflicts.ts";

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
    out.push(...(await conflicts.run(e, ctx())));
  return out;
}
/** The notices those come to, one per dedupe key, as the inbox keeps them. */
const told = (out: ReflexOutcome[]) => [
  ...new Set(out.flatMap((o) => (o.kind === "tell" ? [o.notification.dedupeKey] : []))),
];

describe("overlap notices", () => {
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
    expect(told(await conflicts.onCheck!(check.payload, ctx()))).toHaveLength(1);
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
    expect(await conflicts.onCheck!(check.payload, ctx())).toEqual([]);
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
    expect(told(await outcomes())).toHaveLength(1);
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
