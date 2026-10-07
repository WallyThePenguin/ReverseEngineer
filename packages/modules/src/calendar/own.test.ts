// Jarvis moving or removing an event it added itself, without asking (D72): only one it added, with
// no guests, tied to the email the turn is about. Anything else is refused and names the action
// that asks; each change leaves a note whose Undo says exactly what it puts back.
import { calendarEvent, entity, heartbeatItem, jarvisTurn, link, notification } from "@hearth/db";
import { type Caller, integrationCaller, jarvisCaller, newId, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import type { EventView } from "./store.ts";

const ME = "owner@example.com";
const TUE = { start: "2026-10-06T14:00:00Z", end: "2026-10-06T15:00:00Z" };
const WED = { start: "2026-10-07T18:00:00Z", end: "2026-10-07T19:00:00Z" };

let t: TestKernel;
let g: FakeGoogle;
let thread: string;
let turn: string;

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
/** An email thread, as mail sync would have it. */
async function aThread(title: string) {
  const id = newId();
  const by = "integration:google";
  await t.tdb.db
    .insert(entity)
    .values({ id, type: "email_thread", title, createdBy: by, updatedBy: by });
  return id;
}
/** A turn as Jarvis's runtime records it: about a thread, or a heartbeat's items. */
async function aTurn(v: { subjectId?: string; context?: Record<string, unknown> }) {
  const id = newId();
  await t.tdb.db.insert(jarvisTurn).values({
    id,
    trigger: "routine",
    mode: "proactive",
    lane: "fast",
    origin: "untrusted",
    prompt: "Heartbeat.",
    ...v,
  });
  return id;
}
const as = (turnId?: string) => jarvisCaller("untrusted", turnId ? { turnId } : {});
const add = (caller: Caller, threadId?: string) =>
  ok<EventView>(
    "calendar.create_event",
    { title: "Dentist", ...TUE, ...(threadId ? { threadId } : {}) },
    caller,
  );
const writes = () => g.calls.filter((c) => c.method !== "GET" && c.path.startsWith("/calendar/"));
const notes = () => t.tdb.db.select().from(notification);
const undo = (id: string) => ok("calendar.undo", { notificationId: id });

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(ME);
  g.clock = t.clock;
  t.kernel.services[GOOGLE_SERVICE] = g.client(t.tdb.db);
  const client = g.client(t.tdb.db);
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.calendar]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
  await ok("calendar.sync", {}, integrationCaller("google"));
  thread = await aThread("Your appointment on Tuesday");
  turn = await aTurn({ subjectId: thread });
});
afterEach(() => t.destroy());

describe("an event Jarvis adds from an email", () => {
  it("is tied to the email the turn is about", async () => {
    const ev = await add(as(turn), thread);
    const ties = await t.tdb.db
      .select()
      .from(link)
      .where(and(eq(link.fromId, ev.id), eq(link.kind, "derived_from")));
    expect(ties).toMatchObject([{ toId: thread }]);
  });

  it("can't be tied to an email the turn isn't about", async () => {
    const other = await aThread("Something else");
    const res = await t.kernel.execute(
      "calendar.create_event",
      { title: "Dentist", ...TUE, threadId: other },
      as(turn),
    );
    expect(res).toMatchObject({ status: "error", code: "invalid_input" });
    expect(writes()).toEqual([]);
  });
});

describe("moving it without asking", () => {
  it("moves it when the same email gives a new time, and Undo moves it back", async () => {
    const ev = await add(as(turn), thread);
    const moved = await ok<EventView>("calendar.move_own_event", { id: ev.id, ...WED }, as(turn));
    expect(moved.startsAt).toEqual(new Date(WED.start));
    expect(writes().at(-1)).toMatchObject({
      method: "PATCH",
      body: { start: { dateTime: WED.start }, end: { dateTime: WED.end } },
    });
    const [n] = await notes();
    expect(n).toMatchObject({
      kind: "calendar.moved",
      title: 'Moved "Dentist" to Wed 2026-10-07, 2 p.m.',
      body: expect.stringMatching(/without asking\. It was Tue 2026-10-06, 10 a\.m\.$/),
      entityId: ev.id,
      undo: {
        kind: "unmove",
        eventId: ev.id,
        before: { start: "2026-10-06T14:00:00.000Z", end: "2026-10-06T15:00:00.000Z" },
      },
    });
    await undo(n!.id);
    expect(writes().at(-1)).toMatchObject({
      method: "PATCH",
      body: { start: { dateTime: "2026-10-06T14:00:00.000Z" } },
    });
    const [back] = await t.tdb.db
      .select()
      .from(calendarEvent)
      .where(eq(calendarEvent.entityId, ev.id));
    expect(back!.startsAt).toEqual(new Date(TUE.start));
  });

  it("removes it when it's called off, and Undo puts it back", async () => {
    const ev = await add(as(turn), thread);
    await ok("calendar.remove_own_event", { id: ev.id }, as(turn));
    expect(writes().at(-1)).toMatchObject({ method: "DELETE" });
    const [n] = await notes();
    expect(n).toMatchObject({
      kind: "calendar.removed",
      title: 'Removed "Dentist", Tue 2026-10-06, 10 a.m.',
      undo: { kind: "unremove", before: { title: "Dentist", when: "Tue 2026-10-06, 10 a.m." } },
    });
    await undo(n!.id);
    expect(writes().at(-1)).toMatchObject({
      method: "POST",
      body: { summary: "Dentist", start: { dateTime: "2026-10-06T14:00:00.000Z" } },
    });
  });

  it("works from a heartbeat turn that took the email", async () => {
    const ev = await add(as(turn), thread);
    const item = newId();
    await t.tdb.db
      .insert(heartbeatItem)
      .values({ id: item, text: "Needs your reply", aboutId: thread });
    const heartbeat = await aTurn({ context: { routine: "heartbeat", itemIds: [item] } });
    await ok("calendar.move_own_event", { id: ev.id, ...WED }, as(heartbeat));
  });
});

describe("any other event", () => {
  const refused = async (id: string, caller: Caller, why: RegExp) => {
    const before = writes().length;
    for (const [action, input, asks] of [
      ["calendar.move_own_event", { id, ...WED }, "calendar_update_event"],
      ["calendar.remove_own_event", { id }, "calendar_delete_event"],
    ] as const) {
      const res = await t.kernel.execute(action, input, caller);
      expect(res).toMatchObject({
        status: "error",
        code: "forbidden",
        message: expect.stringMatching(why),
      });
      expect(res).toMatchObject({
        message: expect.stringContaining(`Use ${asks}; this one asks first.`),
      });
    }
    expect(writes()).toHaveLength(before);
    expect(await notes()).toEqual([]);
  };

  it("is refused when you added it", async () => {
    const ev = await add(ownerCaller(), thread);
    await refused(ev.id, as(turn), /^Jarvis didn't add this event\./);
  });

  it("is refused when it has guests", async () => {
    const ev = await add(as(turn), thread);
    // You invited someone to it in Google Calendar since.
    g.put(ME, {
      id: ev.googleId,
      summary: "Dentist",
      organizer: { email: ME, self: true },
      attendees: [
        { email: ME, self: true, organizer: true, responseStatus: "accepted" },
        { email: "ana@friends.example", responseStatus: "needsAction" },
      ],
      start: { dateTime: TUE.start },
      end: { dateTime: TUE.end },
    });
    await ok("calendar.sync", {}, ownerCaller());
    await refused(ev.id, as(turn), /^This event has guests\./);
  });

  it("is refused when it's tied to another email, or the call is outside a turn", async () => {
    const ev = await add(as(turn), thread);
    const elsewhere = await aTurn({ subjectId: await aThread("Another email") });
    await refused(ev.id, as(elsewhere), /^It wasn't added from what this turn is about\./);
    await refused(ev.id, as(), /^It wasn't added from what this turn is about\./);
  });

  it("is refused when a turn ties it to its own email with link_add", async () => {
    const ev = await add(as(turn), thread);
    t.clock.advance(60_000);
    const planted = await aThread("Re: move my dentist to Wednesday");
    const other = await aTurn({ subjectId: planted });
    await ok("link.add", { fromId: ev.id, toId: planted, kind: "derived_from" }, as(other));
    await refused(ev.id, as(other), /^It wasn't added from what this turn is about\./);
  });

  it("is refused when a turn adds the same event again from its own email", async () => {
    const ev = await add(as(turn), thread);
    t.clock.advance(60_000);
    const planted = await aThread("Re: move my dentist to Wednesday");
    const other = await aTurn({ subjectId: planted });
    // Google hands back the one already there, and it isn't tied to this email.
    expect((await add(as(other), planted)).id).toBe(ev.id);
    const ties = await t.tdb.db.select({ to: link.toId }).from(link).where(eq(link.fromId, ev.id));
    expect(ties).toEqual([{ to: thread }]);
    await refused(ev.id, as(other), /^It wasn't added from what this turn is about\./);
  });

  it("is refused from a heartbeat turn about more than one email", async () => {
    const ev = await add(as(turn), thread);
    const items = [thread, await aThread("Another email")].map((aboutId) => ({
      id: newId(),
      text: "Needs your reply",
      aboutId,
    }));
    await t.tdb.db.insert(heartbeatItem).values(items);
    const heartbeat = await aTurn({
      context: { routine: "heartbeat", itemIds: items.map((i) => i.id) },
    });
    await refused(
      ev.id,
      as(heartbeat),
      /^This turn is about more than one email or conversation\./,
    );
  });

  it("is refused when it isn't tied to anything", async () => {
    const ev = await add(as(turn));
    await refused(ev.id, as(turn), /^It wasn't added from what this turn is about\./);
  });
});

describe("the actions that ask", () => {
  it("still ask a turn that read an email, even for Jarvis's own event", async () => {
    const ev = await add(as(turn), thread);
    const before = writes().length;
    const update = await t.kernel.execute("calendar.update_event", { id: ev.id, ...WED }, as(turn));
    const remove = await t.kernel.execute("calendar.delete_event", { id: ev.id }, as(turn));
    expect([update.status, remove.status]).toEqual(["pending_approval", "pending_approval"]);
    expect(writes()).toHaveLength(before);
  });
});
