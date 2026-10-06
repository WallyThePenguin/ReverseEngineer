// Step 7 end to end: a heads-up ten minutes before a real meeting with its prep and join link
// (even while paused, and following a moved meeting), the evening's Your day card, calendar
// rows that say their prep is ready, and what Jarvis did, read from what it made.
import { notification, schedule } from "@hearth/db";
import { type Caller, integrationCaller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { type EventView, GOOGLE_SERVICE, SCOPES } from "@hearth/modules";
import { FakeGoogle } from "@hearth/modules/google-testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";

const ME = "owner@example.com";
let h: JarvisHarness;
let g: FakeGoogle;

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await h.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const sync = () => ok("calendar.sync", {}, integrationCaller("google"));
const inbox = (kind: string) =>
  h.tdb.db.select().from(notification).where(eq(notification.kind, kind));
const at = (iso: string) => ({ dateTime: iso });
const review = (start: string, end: string) => ({
  id: "review",
  summary: "Design review",
  hangoutLink: "https://meet.google.com/abc-defg-hij",
  organizer: { email: ME, self: true },
  attendees: [{ email: ME, self: true }, { email: "sam@example.com" }],
  start: at(start),
  end: at(end),
});
const events = () =>
  ok<EventView[]>("calendar.events", { from: "2026-10-01T00:00:00Z", to: "2026-10-03T00:00:00Z" });

beforeEach(async () => {
  h = await createJarvisHarness("2026-10-01T14:00:00Z"); // Thursday 10 a.m.
  g = new FakeGoogle(ME);
  g.clock = h.clock;
  h.kernel.services[GOOGLE_SERVICE] = g.client();
  const client = g.client();
  const url = new URL(await client.startSignIn(h.tdb.db, [...SCOPES.calendar]));
  await client.finishSignIn(h.tdb.db, url.searchParams.get("state")!, "the-code");
  h.brain.otherwise(() => [{ say: "OK." }]);
});
afterEach(() => h.destroy());

describe("the heads-up before a meeting", () => {
  it("comes ten minutes before, with the prep and the join link, even while paused", async () => {
    g.put(ME, review("2026-10-01T15:00:00Z", "2026-10-01T15:30:00Z"));
    await sync();
    await h.settle();
    const [ev] = await events();
    await ok("prep.publish", { eventId: ev!.id, markdown: "Ask Sam about the budget." });
    const prepId = (await events())[0]?.prepId;
    expect(prepId).toBeTruthy();
    // The event's own page opens with the same packet.
    expect((await ok<EventView>("calendar.get", { id: ev!.id })).prepId).toBe(prepId);
    await ok("jarvis.pause", {});
    h.clock.set("2026-10-01T14:49:00Z");
    await h.settle();
    expect(await inbox("calendar.meeting_soon")).toEqual([]);
    h.clock.set("2026-10-01T14:50:10Z");
    await h.settle();
    expect(await inbox("calendar.meeting_soon")).toMatchObject([
      {
        title: '"Design review" in 10 min',
        body: "Ask Sam about the budget.\nJoin: https://meet.google.com/abc-defg-hij",
        entityId: ev!.id,
        urgency: "interrupt",
      },
    ]);
    expect(h.brain.requests).toHaveLength(0);
  });

  it("follows a meeting that moved, and skips a short one on your own", async () => {
    g.put(ME, review("2026-10-01T15:00:00Z", "2026-10-01T15:30:00Z"));
    g.put(ME, {
      id: "call",
      summary: "Call mum",
      start: at("2026-10-01T15:00:00Z"),
      end: at("2026-10-01T15:15:00Z"),
    });
    await sync();
    g.put(ME, review("2026-10-01T16:00:00Z", "2026-10-01T16:30:00Z"));
    await sync();
    await h.settle();
    h.clock.set("2026-10-01T14:50:10Z");
    await h.settle();
    expect(await inbox("calendar.meeting_soon")).toEqual([]);
    h.clock.set("2026-10-01T15:50:10Z");
    await h.settle();
    expect((await inbox("calendar.meeting_soon")).map((n) => n.title)).toEqual([
      '"Design review" in 10 min',
    ]);
  });

  it("is set up for meetings already on the calendar when the heartbeat looks ahead", async () => {
    g.put(ME, review("2026-10-01T15:00:00Z", "2026-10-01T15:30:00Z"));
    await sync();
    await h.settle();
    // As if Hearth had been updated with the meeting already there.
    await h.tdb.db.delete(schedule).where(eq(schedule.kind, "check"));
    h.clock.set("2026-10-01T14:25:10Z"); // the heartbeat
    await h.settle();
    h.clock.set("2026-10-01T14:50:10Z");
    await h.settle();
    expect(await inbox("calendar.meeting_soon")).toHaveLength(1);
  });
});

describe("the evening and what Jarvis did", () => {
  it("sends Your day with tomorrow's first meetings and what's due", async () => {
    g.put(ME, review("2026-10-02T13:00:00Z", "2026-10-02T14:00:00Z")); // Fri 9 a.m.
    await sync();
    await ok("task.create", { title: "Send the deck", dueAt: "2026-10-02T20:00:00Z" });
    h.clock.set("2026-10-01T23:30:00Z"); // 7:30 p.m.
    const journal = await ok<{ id: string }>(
      "journal.write",
      { markdown: "A quiet day.", date: "2026-10-01" },
      jarvisCaller("system"),
    );
    expect(await inbox("wrap")).toMatchObject([
      {
        title: "Your day",
        body: "Tomorrow: 9 a.m. Design review\n1 task due tomorrow.",
        entityId: journal.id,
      },
    ]);
  });

  it("lists what Jarvis made, with the turn that made it", async () => {
    h.brain.next([{ call: "task_create", input: { title: "Book the venue" } }, { say: "Done." }]);
    await ok("chat.send", { text: "remind me to book the venue" });
    await h.settle();
    await ok("task.create", { title: "Mine, not Jarvis's" });
    const did = await ok<{ text: string; turnId?: string }[]>("jarvis.did", {
      since: "2026-10-01T00:00:00Z",
    });
    expect(did).toMatchObject([
      { text: "Made a task: Book the venue", turnId: expect.any(String) },
    ]);
  });
});
