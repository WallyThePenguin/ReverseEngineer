import { calendarEvent, entity, googleAccount, notification } from "@hearth/db";
import { integrationCaller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { type EventView, GOOGLE_SERVICE, type TaskView } from "@hearth/modules";
import { FakeGoogle } from "@hearth/modules/google-testing";
import { and, eq, isNotNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";

let h: JarvisHarness;
let g: FakeGoogle;
const CAL = "owner@example.com";

beforeEach(async () => {
  h = await createJarvisHarness("2026-10-01T14:00:00Z"); // Thursday 10 a.m. Eastern
  g = new FakeGoogle(CAL);
  h.kernel.services[GOOGLE_SERVICE] = g.client();
  const client = g.client();
  const url = new URL(
    await client.startSignIn(h.tdb.db, ["https://www.googleapis.com/auth/calendar"]),
  );
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  await client.finishSignIn(h.tdb.db, url.searchParams.get("state")!, "the-code");
});
afterEach(() => h.destroy());

async function ok<T>(name: string, input: unknown, caller = ownerCaller()): Promise<T> {
  const res = await h.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const sync = () => ok("calendar.sync", {}, integrationCaller("google"));
const events = () =>
  ok<EventView[]>("calendar.events", { from: "2026-10-01T00:00:00Z", to: "2026-10-10T00:00:00Z" });
const inbox = (kind: string) =>
  h.tdb.db.select().from(notification).where(eq(notification.kind, kind));
const at = (iso: string) => ({ dateTime: iso });

describe("Google Calendar", () => {
  it("connects an account and pulls its events, marked as coming from Google", async () => {
    const [acct] = await h.tdb.db.select().from(googleAccount);
    expect(acct).toMatchObject({ email: CAL, refreshToken: "rt", status: "ok" });
    g.put(CAL, {
      summary: "Dentist",
      start: at("2026-10-02T15:00:00Z"),
      end: at("2026-10-02T16:00:00Z"),
    });
    g.put(CAL, { summary: "Holiday", start: { date: "2026-10-05" }, end: { date: "2026-10-06" } });
    await sync();
    const list = await events();
    expect(list.map((e) => [e.title, e.allDay])).toEqual([
      ["Dentist", false],
      ["Holiday", true],
    ]);
    // All-day dates are local days.
    expect(list[1]!.startsAt.toISOString()).toBe("2026-10-05T04:00:00.000Z");
    const [row] = await h.tdb.db.select().from(entity).where(eq(entity.type, "event"));
    expect(row?.createdBy).toBe("integration:google");
  });

  it("notices moves and deletions made in Google", async () => {
    const ev = g.put(CAL, {
      summary: "1:1",
      start: at("2026-10-02T15:00:00Z"),
      end: at("2026-10-02T15:30:00Z"),
    });
    await sync();
    g.put(CAL, { ...ev, start: at("2026-10-02T17:00:00Z"), end: at("2026-10-02T17:30:00Z") });
    await sync();
    g.remove(CAL, ev.id);
    await sync();
    const changes = (await h.events("calendar.event_changed")).map((e) => e.payload.change);
    expect(changes).toEqual(["added", "updated", "cancelled"]);
    expect(await events()).toEqual([]);
  });

  it("writes your own calendar directly, and asks before inviting anyone", async () => {
    await sync();
    const mine = await ok<EventView>(
      "calendar.create_event",
      { title: "Gym", start: "2026-10-02T11:00:00-04:00", end: "2026-10-02T12:00:00-04:00" },
      jarvisCaller("owner"),
    );
    expect(g.calls.at(-1)).toMatchObject({ method: "POST" });
    expect([...g.calendars.get(CAL)!.events.values()].map((e) => e.summary)).toEqual(["Gym"]);
    await ok("calendar.update_event", { id: mine.id, title: "Gym (legs)" }, jarvisCaller("owner"));
    expect((await events())[0]?.title).toBe("Gym (legs)");

    const invite = await h.kernel.execute(
      "calendar.schedule_meeting",
      {
        title: "Lunch",
        start: "2026-10-02T12:00:00-04:00",
        end: "2026-10-02T13:00:00-04:00",
        attendees: ["sam@example.com"],
      },
      jarvisCaller("owner"),
    );
    expect(invite.status).toBe("pending_approval");

    const meeting = g.put(CAL, {
      summary: "Standup",
      start: at("2026-10-02T13:00:00Z"),
      end: at("2026-10-02T13:15:00Z"),
      organizer: { email: CAL, self: true },
      attendees: [{ email: CAL, self: true }, { email: "sam@example.com" }],
    });
    await sync();
    const standup = (await events()).find((e) => e.googleId === meeting.id)!;
    const direct = await h.kernel.execute(
      "calendar.update_event",
      { id: standup.id, title: "Standup!" },
      ownerCaller(),
    );
    expect(direct).toMatchObject({ status: "error", code: "forbidden" });
  });

  it("finds free time in working hours only, around meetings", async () => {
    g.put(CAL, {
      summary: "Busy",
      start: at("2026-10-02T13:00:00Z"), // Fri 9 a.m.
      end: at("2026-10-02T20:00:00Z"), // 4 p.m.
    });
    await sync();
    const slots = await ok<{ start: Date; end: Date }[]>("calendar.free_time", {
      from: "2026-10-02T04:00:00Z",
      days: 3,
      minutes: 60,
    });
    // Friday 4 to 6 p.m., then nothing on the weekend.
    expect(slots.map((s) => [s.start.toISOString(), s.end.toISOString()])).toEqual([
      ["2026-10-02T20:00:00.000Z", "2026-10-02T22:00:00.000Z"],
    ]);
  });

  it("time-blocks a big task before it's due, and takes the block back when it's done", async () => {
    await sync();
    const t = await ok<TaskView>("task.create", {
      title: "Write the report",
      estimateMinutes: 180,
      dueAt: "2026-10-02T22:00:00Z",
    });
    h.clock.advance(3 * 60_000);
    await h.settle();
    const blocks = (await events()).filter((e) => e.taskId === t.id);
    expect(blocks.map((b) => [b.title, b.startsAt.toISOString(), b.endsAt.toISOString()])).toEqual([
      ["Focus: Write the report", "2026-10-01T14:45:00.000Z", "2026-10-01T16:45:00.000Z"],
      ["Focus: Write the report", "2026-10-01T16:45:00.000Z", "2026-10-01T17:45:00.000Z"],
    ]);
    await ok("task.update", { id: t.id, status: "completed" });
    h.clock.advance(3 * 60_000);
    await h.settle();
    expect((await events()).filter((e) => e.taskId === t.id)).toEqual([]);
    expect(g.calendars.get(CAL)!.events.size).toBe(0);
  });

  it("warns about overlapping meetings once", async () => {
    g.put(CAL, {
      summary: "A",
      start: at("2026-10-02T15:00:00Z"),
      end: at("2026-10-02T16:00:00Z"),
    });
    g.put(CAL, {
      summary: "B",
      start: at("2026-10-02T15:30:00Z"),
      end: at("2026-10-02T16:30:00Z"),
    });
    await sync();
    await h.settle();
    const conflicts = await inbox("calendar.conflict");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.title).toMatch(/^"[AB]" overlaps "[AB]"$/);
  });

  it("makes prep packets at 6 a.m., plain ones when Jarvis is paused", async () => {
    g.put(CAL, {
      summary: "Planning with Sam",
      start: at("2026-10-02T15:00:00Z"),
      end: at("2026-10-02T16:00:00Z"),
      attendees: [
        { email: CAL, self: true },
        { email: "sam@example.com", displayName: "Sam" },
      ],
    });
    await sync();
    await ok("person.create", { name: "Sam", notes: "sam@example.com, runs the budget." });
    await ok("jarvis.pause", {});
    h.clock.set("2026-10-02T10:00:30Z"); // Friday 6 a.m.
    await h.settle();
    const [prep] = await h.tdb.db.select().from(entity).where(eq(entity.type, "prep"));
    expect(prep?.title).toBe("Prep: Planning with Sam (2026-10-02)");
    expect(prep?.body).toContain("runs the budget");
  });

  it("puts today's events in the brief and alerts when Google signs Hearth out", async () => {
    g.put(CAL, {
      summary: "Dentist",
      start: at("2026-10-01T19:00:00Z"),
      end: at("2026-10-01T20:00:00Z"),
    });
    await sync();
    const digest = await h.engine.digest(new Date("2026-10-01T00:00:00Z"));
    const today = digest.flatMap((d) => d.items).filter((i) => i.bucket === "today");
    expect(today.map((i) => i.text)).toContain("3 p.m. Dentist");
    await h.kernel.db.update(googleAccount).set({ accessExpiresAt: new Date(0) });
    g.revoked = true;
    await sync();
    await h.settle();
    const [alert] = await inbox("system.alert");
    expect(alert?.title).toBe("Google Calendar isn't syncing");
    const [acct] = await h.tdb.db.select().from(googleAccount);
    expect(acct?.status).toBe("revoked");
  });

  it("keeps time blocks linked to their task", async () => {
    await sync();
    const t = await ok<TaskView>("task.create", { title: "Taxes", estimateMinutes: 60 });
    await ok("calendar.block_task", { taskId: t.id }, jarvisCaller("owner"));
    const rows = await h.tdb.db
      .select()
      .from(calendarEvent)
      .where(and(isNotNull(calendarEvent.taskId)));
    expect(rows).toHaveLength(1);
  });
});
