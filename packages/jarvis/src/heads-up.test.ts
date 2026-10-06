// Step 7 end to end: a heads-up ten minutes before a real meeting with its prep and join link
// (even while paused, and following a moved meeting), the evening's Your day card, calendar
// rows that say their prep is ready, and what Jarvis did, read from what it made.
import { entity, notification, schedule, setting } from "@hearth/db";
import {
  type Caller,
  integrationCaller,
  jarvisCaller,
  ownerCaller,
  systemCaller,
} from "@hearth/kernel";
import { type EventView, GOOGLE_SERVICE, gist, SCOPES } from "@hearth/modules";
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
        body: "Join: https://meet.google.com/abc-defg-hij\nAsk Sam about the budget.",
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
  it("doesn't use up the day's interrupts, and skips calendars that aren't yours", async () => {
    await h.kernel.db.insert(setting).values({ key: "owner.maxInterruptsPerDay", value: 1 });
    g.put(ME, review("2026-10-01T15:00:00Z", "2026-10-01T16:00:00Z"));
    // Shared with you: their dentist is no heads-up of yours.
    g.addCalendar({ id: "partner@example.com", summary: "Partner", accessRole: "owner" });
    g.put("partner@example.com", {
      ...review("2026-10-01T15:00:00Z", "2026-10-01T16:00:00Z"),
      id: "theirs",
      summary: "Their dentist",
      organizer: { email: "partner@example.com", self: true },
    });
    await sync();
    h.clock.set("2026-10-01T14:50:10Z");
    await h.settle();
    expect((await inbox("calendar.meeting_soon")).map((n) => n.title)).toEqual([
      '"Design review" in 10 min',
    ]);
    const alert = await ok<{ delivered: boolean }>(
      "inbox.notify",
      { title: "Backup failed", urgency: "interrupt" },
      systemCaller(),
    );
    expect(alert.delivered).toBe(true);
  });

  it("starts a plain prep with what it says, not its facts", () => {
    const facts = [
      "## Design review",
      "- When: Thu 11 a.m.",
      "- Event id: 7f0c",
      "- Guests: Sam",
      "- About Sam (person 9a1b): runs the budget",
      "Bring the Q3 numbers.",
    ].join("\n");
    expect(gist(facts)).toBe("Bring the Q3 numbers.");
    expect(gist("## Only facts\n- When: now")).toBe("");
  });

  it("waits for the evening to send Your day", async () => {
    h.clock.set("2026-10-01T18:00:00Z"); // 2 p.m.
    await ok("journal.write", { markdown: "Noted.", date: "2026-10-01" }, jarvisCaller("owner"));
    expect(await inbox("wrap")).toEqual([]);
    h.clock.set("2026-10-01T23:30:00Z"); // 7:30 p.m.
    await ok("journal.write", { markdown: "The day.", date: "2026-10-01" }, jarvisCaller("system"));
    expect(await inbox("wrap")).toHaveLength(1);
  });

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
    type Did = { text: string; entityId: string; turnId?: string; outside: boolean };
    const did = () => ok<Did[]>("jarvis.did", { since: "2026-10-01T00:00:00Z" });
    const made = await did();
    expect(made).toMatchObject([
      { text: "Made a task: Book the venue", turnId: expect.any(String), outside: false },
    ]);
    // One written after reading outside content says so, as the record does (D58).
    await h.tdb.db.update(entity).set({ outside: true }).where(eq(entity.id, made[0]!.entityId));
    expect(await did()).toMatchObject([{ outside: true }]);
  });
});
