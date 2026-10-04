// Calendar sync, paced and hard to stall (D55, 6.2): a slowdown waits for the next round, and one
// event that won't save is skipped instead of failing the rest.
import { randomBytes } from "node:crypto";
import { calendarEvent, entity } from "@hearth/db";
import { integrationCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import type { SyncResult } from "./sync.ts";

const ME = "owner@example.com";

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
    // Paused for every process: the next sync in the same minute doesn't ask Google.
    const calls = g.calls.length;
    expect(await sync()).toMatchObject({ paused: [ME] });
    expect(g.calls.length).toBe(calls);
    t.clock.advance(61_000);
    expect(await sync()).toMatchObject({ failed: [], paused: [], events: 1 });
    expect(await titles()).toEqual(["Standup"]);
  });

  it("still alerts when Google fails for another reason", async () => {
    g.failCalendar(1, 500);
    expect((await sync()).failed).toHaveLength(1);
    expect(await t.events("calendar.sync_failed")).toHaveLength(1);
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
