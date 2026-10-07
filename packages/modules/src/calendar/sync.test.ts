// Calendar sync, paced and hard to stall (D55, 6.2): a slowdown waits for the next round, and one
// event that won't save is skipped instead of failing the rest. Failures that last are told once
// and closed when it syncs again (D61).
import { randomBytes, randomUUID } from "node:crypto";
import {
  calendar,
  calendarEvent,
  entity,
  googleAccount,
  googleQuota,
  notification,
} from "@hearth/db";
import { getSetting, type HearthEvent, integrationCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import { type SyncResult, syncWindow } from "./sync.ts";

const ME = "owner@example.com";
const DAY_MS = 24 * 3600_000;

let t: TestKernel;
let g: FakeGoogle;

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(ME);
  g.clock = t.clock;
  t.kernel.services[GOOGLE_SERVICE] = g.client(t.tdb.db);
  const client = g.client(t.tdb.db);
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.calendar]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
});
afterEach(() => t.destroy());

const sync = async () => {
  const res = await t.kernel.execute<SyncResult>("calendar.sync", {}, integrationCaller("google"));
  if (res.status !== "ok") throw new Error(JSON.stringify(res));
  return res.result;
};
const titles = async () =>
  (
    await t.tdb.db
      .select({ title: entity.title })
      .from(calendarEvent)
      .innerJoin(entity, eq(entity.id, calendarEvent.entityId))
  )
    .map((r) => r.title)
    .sort();
const at = (iso: string) => ({ dateTime: iso });
const health = async () =>
  (await t.tdb.db.select().from(googleAccount).where(eq(googleAccount.email, ME)))[0]!;

/** What the calendar.sync_failed reflex makes of an event, saved as the notice it would be. */
async function notice(e: HearthEvent) {
  const reflex = ALL_MODULES.flatMap((m) => m.reflexes ?? []).find(
    (r) => r.name === "calendar.sync_failed",
  )!;
  const [out] = await reflex.run(e, { db: t.tdb.db, now: t.clock.now() } as never);
  const key = (out as { notification: { dedupeKey: string } }).notification.dedupeKey;
  await t.tdb.db.insert(notification).values({
    id: randomUUID(),
    kind: "system.alert",
    title: "Google Calendar",
    dedupeKey: key,
    createdBy: "jarvis",
  });
  return key;
}
const stateOf = async (key: string) =>
  (await t.tdb.db.select().from(notification).where(eq(notification.dedupeKey, key)))[0]?.state;

describe("calendar sync", () => {
  it("waits for the next round when Google says slow down, without an alert", async () => {
    g.put(ME, {
      summary: "Standup",
      start: at("2026-10-02T14:00:00Z"),
      end: at("2026-10-02T14:30:00Z"),
    });
    g.failCalendar(1, 429);
    expect(await sync()).toMatchObject({ failed: [], paused: [ME], events: 0 });
    expect(await t.events("calendar.sync_failed")).toEqual([]);
    expect(await health()).toMatchObject({ calendarState: "ok", calendarFailures: 0 });
    // What Google said is kept for Settings and the doctor.
    const [pause] = await t.tdb.db.select().from(googleQuota);
    expect(pause?.reason).toContain("Quota exceeded");
    // Paused for every process: the next sync in the same minute doesn't ask Google.
    const calls = g.calls.length;
    expect(await sync()).toMatchObject({ paused: [ME] });
    expect(g.calls.length).toBe(calls);
    t.clock.advance(61_000);
    expect(await sync()).toMatchObject({ failed: [], paused: [], events: 1 });
    expect(await titles()).toEqual(["Standup"]);
  });

  it("tells you once when calendars keep failing, and closes the notice when they sync", async () => {
    await sync();
    const outage = async () => {
      g.failCalendar(1, 500);
      expect((await sync()).failed).toHaveLength(1);
      t.clock.advance(10 * 60_000);
    };
    // A blip or two isn't news.
    await outage();
    await outage();
    expect(await t.events("calendar.sync_failed")).toEqual([]);
    expect(await health()).toMatchObject({ calendarState: "ok", calendarFailures: 2 });
    // Three in a row with nothing read for half an hour is, once.
    await outage();
    await outage();
    const failed = await t.events("calendar.sync_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toMatchObject({ account: ME, reconnect: false });
    expect(await health()).toMatchObject({ calendarState: "failing" });
    // Each calendar says why in Settings, the list it couldn't read included.
    const [cal] = await t.tdb.db.select().from(calendar).where(eq(calendar.selected, true));
    expect(cal?.lastError).toContain("Backend Error");
    const key = await notice(failed[0]!);
    expect(await sync()).toMatchObject({ failed: [] });
    expect(await stateOf(key)).toBe("done");
    expect(await health()).toMatchObject({ calendarState: "ok", calendarError: null });
  });

  it("counts half an hour from when the PC woke, not from the sync before it slept", async () => {
    await sync();
    const failedRound = async () => {
      g.failCalendar(1, 500);
      expect((await sync()).failed).toHaveLength(1);
    };
    // Two rounds failed as the PC went to sleep, and the first after it wakes fails too.
    await failedRound();
    t.clock.advance(5 * 60_000);
    await failedRound();
    t.clock.advance(8 * 3600_000);
    await failedRound();
    expect(await t.events("calendar.sync_failed")).toEqual([]);
    expect(await health()).toMatchObject({ calendarState: "ok", calendarFailures: 1 });
    // Still failing, a round every five minutes: half an hour after the wake, that's news.
    for (let m = 5; m < 30; m += 5) {
      t.clock.advance(5 * 60_000);
      await failedRound();
    }
    expect(await t.events("calendar.sync_failed")).toEqual([]);
    t.clock.advance(5 * 60_000);
    await failedRound();
    expect(await t.events("calendar.sync_failed")).toHaveLength(1);
  });

  it("isn't failing over one calendar Google says isn't there while the others sync", async () => {
    g.addCalendar({ id: "holidays", summary: "Holidays", accessRole: "owner" });
    await sync();
    g.brokenCalendars.set("holidays", 404);
    for (let i = 0; i < 4; i++) {
      expect((await sync()).failed).toEqual([expect.stringContaining("Holidays")]);
      t.clock.advance(10 * 60_000);
    }
    expect(await t.events("calendar.sync_failed")).toEqual([]);
    // Settings and the doctor still say which calendar and why.
    expect(await health()).toMatchObject({ calendarState: "ok", calendarError: /Holidays/ });
    // Alone, with nothing else read, it is the account failing: told at once, as before.
    await t.tdb.db.update(calendar).set({ selected: false }).where(eq(calendar.googleId, ME));
    await sync();
    expect(await health()).toMatchObject({ calendarState: "failing" });
  });

  it("tells you at once when Google signs Hearth out, and how to connect again", async () => {
    await sync();
    await t.tdb.db.update(googleAccount).set({ accessExpiresAt: new Date(0) });
    g.revoked = true;
    expect((await sync()).failed).toHaveLength(1);
    const [e] = await t.events("calendar.sync_failed");
    expect(e?.payload).toMatchObject({ account: ME, reconnect: true });
    expect(await health()).toMatchObject({ calendarState: "revoked" });
    const reflex = ALL_MODULES.flatMap((m) => m.reflexes ?? []).find(
      (r) => r.name === "calendar.sync_failed",
    )!;
    const [out] = await reflex.run(e!, { db: t.tdb.db, now: t.clock.now() } as never);
    expect(JSON.stringify(out)).toContain("Connect the account again in Settings");
  });

  it("tells you at once about a calendar Google won't show", async () => {
    await sync();
    g.failCalendar(1, 404);
    expect((await sync()).failed).toHaveLength(1);
    expect(await t.events("calendar.sync_failed")).toHaveLength(1);
    expect(await health()).toMatchObject({ calendarState: "failing", calendarFailures: 1 });
    // Each account's notice is its own, so two failing together are both told.
    const [failed] = await t.events("calendar.sync_failed");
    expect(await notice(failed!)).toBe(
      `calendar.sync_failed:${ME}:${(failed!.payload as { since: string }).since}`,
    );
    // An alert Jarvis gets to after it synced again stays unsaid.
    const [late] = await t.events("calendar.sync_failed");
    await sync();
    const reflex = ALL_MODULES.flatMap((m) => m.reflexes ?? []).find(
      (r) => r.name === "calendar.sync_failed",
    )!;
    expect(await reflex.run(late!, { db: t.tdb.db, now: t.clock.now() } as never)).toEqual([]);
  });

  it("skips an event that won't save, and keeps the rest", async () => {
    g.put(ME, {
      summary: "Lunch\u0000 with Ana",
      start: at("2026-10-02T16:00:00Z"),
      end: at("2026-10-02T17:00:00Z"),
    });
    // A UID too long for its index: Postgres refuses the row.
    g.put(ME, {
      summary: "Odd",
      iCalUID: `${randomBytes(6000).toString("base64url")}@x.example`,
      start: at("2026-10-03T16:00:00Z"),
      end: at("2026-10-03T17:00:00Z"),
    });
    g.put(ME, {
      summary: "Review",
      start: at("2026-10-04T16:00:00Z"),
      end: at("2026-10-04T17:00:00Z"),
    });
    expect(await sync()).toMatchObject({ failed: [], skipped: 1, events: 3 });
    expect(await titles()).toEqual(["Lunch with Ana", "Review"]);
    expect(await t.events("calendar.sync_failed")).toEqual([]);
  });

  it("leaves an event that ended as the window starts alone", async () => {
    // Google lists what ends after the window's start, so one ending right at it isn't listed,
    // and isn't gone either.
    const { timeZone } = await getSetting(t.tdb.db, "owner.dayRules");
    const { from } = syncWindow(t.clock.now(), timeZone);
    const end = new Date(from.getTime() + DAY_MS);
    g.put(ME, {
      summary: "Offsite",
      start: at(new Date(end.getTime() - 3600_000).toISOString()),
      end: at(end.toISOString()),
    });
    expect(await sync()).toMatchObject({ events: 1 });
    t.clock.advance(DAY_MS);
    expect(await sync()).toMatchObject({ failed: [], events: 0, changed: 0 });
    const [row] = await t.tdb.db.select({ status: calendarEvent.status }).from(calendarEvent);
    expect(row?.status).toBe("confirmed");
  });

  it("says plainly when Google asks it to slow down on a change you make", async () => {
    await sync();
    g.failCalendar(1, 403);
    const res = await t.kernel.execute(
      "calendar.create_event",
      { title: "Focus", start: "2026-10-05T14:00:00Z", end: "2026-10-05T15:00:00Z" },
      ownerCaller(),
    );
    expect(res).toMatchObject({ status: "error", code: "unavailable" });
    expect(JSON.stringify(res)).toContain("asked Hearth to slow down");
  });
});
