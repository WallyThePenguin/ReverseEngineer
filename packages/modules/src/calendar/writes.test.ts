// Writes to Google Calendar happen once (D61): an event Google made while Hearth didn't hear back
// is found, not made twice, and a time block keeps its task even if Hearth never saved it.
import { calendarEvent } from "@hearth/db";
import { integrationCaller, ownerCaller } from "@hearth/kernel";
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
  g = new FakeGoogle(ME);
  g.clock = t.clock;
  t.kernel.services[GOOGLE_SERVICE] = g.client(t.tdb.db);
  const client = g.client(t.tdb.db);
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.calendar]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
  await ok("calendar.sync", {});
});
afterEach(() => t.destroy());

async function ok<T>(name: string, input: unknown): Promise<T> {
  const res = await t.kernel.execute<T>(name, input, ownerCaller());
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const focus = { title: "Focus", start: "2026-10-05T14:00:00Z", end: "2026-10-05T15:00:00Z" };
const atGoogle = () =>
  [...g.calendars.get(ME)!.events.values()].filter((e) => e.status !== "cancelled");

describe("calendar writes", () => {
  it("doesn't add an event twice when Google made it but didn't answer", async () => {
    g.loseCalendarReplies = 1;
    const first = await t.kernel.execute("calendar.create_event", focus, ownerCaller());
    expect(first).toMatchObject({ status: "error" });
    expect(atGoogle()).toHaveLength(1);
    const ev = await ok<EventView>("calendar.create_event", focus);
    expect(ev).toMatchObject({ title: "Focus", googleId: atGoogle()[0]!.id });
    expect(atGoogle()).toHaveLength(1);
  });

  it("adds the same event again after the first was deleted", async () => {
    const ev = await ok<EventView>("calendar.create_event", focus);
    await ok("calendar.delete_event", { id: ev.id });
    expect(atGoogle()).toHaveLength(0);
    const again = await ok<EventView>("calendar.create_event", focus);
    expect(again.googleId).not.toBe(ev.googleId);
    expect(atGoogle()).toHaveLength(1);
  });

  it("adds a new event when the one with that id was moved since", async () => {
    const ev = await ok<EventView>("calendar.create_event", focus);
    await ok("calendar.update_event", {
      id: ev.id,
      start: "2026-10-05T16:00:00Z",
      end: "2026-10-05T17:00:00Z",
    });
    const again = await ok<EventView>("calendar.create_event", focus);
    expect(again.id).not.toBe(ev.id);
    expect(atGoogle()).toHaveLength(2);
  });

  it("knows a time block's task from Google, even when Hearth never saved the block", async () => {
    const task = await ok<{ id: string }>("task.create", { title: "Write the report" });
    g.put(ME, {
      summary: "Write the report",
      start: { dateTime: "2026-10-06T14:00:00Z" },
      end: { dateTime: "2026-10-06T16:00:00Z" },
      extendedProperties: { private: { hearthTask: task.id } },
    });
    g.put(ME, {
      summary: "Not ours",
      start: { dateTime: "2026-10-06T17:00:00Z" },
      end: { dateTime: "2026-10-06T18:00:00Z" },
      extendedProperties: { private: { hearthTask: "not-a-task" } },
    });
    const res = await t.kernel.execute("calendar.sync", {}, integrationCaller("google"));
    expect(res).toMatchObject({ status: "ok", result: { skipped: 0 } });
    const rows = await t.tdb.db.select({ taskId: calendarEvent.taskId }).from(calendarEvent);
    expect(rows.map((r) => r.taskId).sort()).toEqual([task.id, null]);
  });
});
