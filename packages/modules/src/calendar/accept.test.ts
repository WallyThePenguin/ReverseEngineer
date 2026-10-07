// Jarvis accepting an invitation on its own (D71): only a yes, only from someone you know or a
// colleague, only when you're free (every time in the next 4 weeks, for a repeating meeting).
// Anything else is refused and names calendar_respond, which still asks; the note it leaves has
// an Undo that only you can press, and nothing but the calendar's own code can write.
import { calendarEvent, notification, personEmail } from "@hearth/db";
import { type Caller, integrationCaller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GAttendee } from "../google/calendar-api.ts";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";

const ME = "owner@acme.example";
const SAM = "sam@partner.example"; // someone you know
const LEE = "lee@acme.example"; // a colleague
const GUEST = "guest@other.example";

let t: TestKernel;
let g: FakeGoogle;
const jarvis = jarvisCaller("untrusted");

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const sync = () => ok("calendar.sync", {}, integrationCaller("google"));
const attendees = (organizer: string, mine = "needsAction"): GAttendee[] => [
  { email: organizer, organizer: true, responseStatus: "accepted" },
  { email: GUEST, responseStatus: "needsAction" },
  { email: ME, self: true, responseStatus: mine as GAttendee["responseStatus"] },
];
const invite = (id: string, organizer: string, day = "2026-10-06", mine = "needsAction") => ({
  id,
  summary: "Standup",
  organizer: { email: organizer },
  attendees: attendees(organizer, mine),
  start: { dateTime: `${day}T15:00:00Z` },
  end: { dateTime: `${day}T16:00:00Z` },
});
const weekly = (day: string) => ({
  ...invite(`wk_${day.replace(/-/g, "")}`, SAM, day),
  recurringEventId: "wk",
});
const busy = (id: string, day: string) =>
  g.put(ME, {
    id,
    summary: "Dentist",
    start: { dateTime: `${day}T15:30:00Z` },
    end: { dateTime: `${day}T16:30:00Z` },
  });
const eventId = async (googleId: string) =>
  (
    await t.tdb.db
      .select({ id: calendarEvent.entityId })
      .from(calendarEvent)
      .where(eq(calendarEvent.googleId, googleId))
  )[0]!.id;
const row = async (googleId: string) =>
  (await t.tdb.db.select().from(calendarEvent).where(eq(calendarEvent.googleId, googleId)))[0]!;
const accept = (id: string) => t.kernel.execute("calendar.accept_invite", { id }, jarvis);
const patches = () => g.calls.filter((c) => c.method === "PATCH");
const mine = (body: unknown) =>
  (body as { attendees: GAttendee[] }).attendees.find((a) => a.self)?.responseStatus;
const notes = () => t.tdb.db.select().from(notification);
const isPerson = async (address: string) =>
  (await t.tdb.db.select().from(personEmail).where(eq(personEmail.address, address))).length > 0;
const known = async (name: string, email: string) => {
  const p = await ok<{ id: string }>("person.create", { name });
  await ok("person.add_email", { id: p.id, email });
  return p.id;
};

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(ME);
  g.clock = t.clock;
  t.kernel.services[GOOGLE_SERVICE] = g.client(t.tdb.db);
  const client = g.client(t.tdb.db);
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.calendar]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
  await known("Sam Lee", SAM);
});
afterEach(() => t.destroy());

describe("accepting an invitation without asking", () => {
  it("accepts one from someone you know when you're free, and says so with Undo", async () => {
    g.put(ME, invite("standup", SAM));
    await sync();
    const id = await eventId("standup");
    expect(await accept(id)).toMatchObject({ status: "ok" });
    expect(patches()).toHaveLength(1);
    expect(patches()[0]!.path).toMatch(/\/events\/standup$/);
    expect(mine(patches()[0]!.body)).toBe("accepted");
    expect(await row("standup")).toMatchObject({ selfResponse: "accepted", jarvisAccepted: true });
    expect(await notes()).toMatchObject([
      {
        kind: "calendar.accepted",
        title: 'Accepted Sam Lee\'s "Standup", Tue 2026-10-06, 11 a.m.',
        body: `You were free then. Invitation from ${SAM}.`,
        entityId: id,
        createdBy: "jarvis",
        urgency: "normal",
        undo: { kind: "unaccept", eventId: id, before: { scope: "this" } },
      },
    ]);
    // Its guests don't become people: only your own yes or your own mail does that.
    expect(await isPerson(GUEST)).toBe(false);
  });

  it("accepts a colleague's, by your own company's domain", async () => {
    g.put(ME, invite("sync", LEE));
    await sync();
    expect(await accept(await eventId("sync"))).toMatchObject({ status: "ok" });
  });

  it("still makes the guests of a meeting you accepted yourself people", async () => {
    g.put(ME, invite("standup", SAM));
    await sync();
    await ok("calendar.respond", { id: await eventId("standup"), response: "accepted" });
    expect(await row("standup")).toMatchObject({ jarvisAccepted: false });
    expect(await isPerson(GUEST)).toBe(true);
  });

  // Each puts the invitation "x" on a calendar, and whatever else it needs.
  const refusals: [string, () => unknown, RegExp][] = [
    ["a stranger's", () => g.put(ME, invite("x", "promo@prizes.example")), /doesn't know/],
    [
      "a role address's, even at your company",
      () => g.put(ME, invite("x", "events@acme.example")),
      /role address/,
    ],
    [
      "one from someone you put in the trash",
      async () => {
        await ok("entity.trash", { id: await known("Pat", "pat@else.example") });
        g.put(ME, invite("x", "pat@else.example"));
      },
      /doesn't know/,
    ],
    [
      "one that overlaps something",
      () => {
        busy("dentist", "2026-10-06");
        g.put(ME, invite("x", SAM));
      },
      /overlaps "Dentist"/,
    ],
    [
      "one you've answered",
      () => g.put(ME, invite("x", SAM, "2026-10-06", "declined")),
      /answered already/,
    ],
    [
      "one on a calendar someone shared with you",
      async () => {
        g.shareCalendar({ id: "ana@acme.example", summary: "Ana" }, { [ME]: "owner" });
        g.put("ana@acme.example", {
          ...invite("x", SAM),
          attendees: [{ email: "ana@acme.example", self: true, responseStatus: "needsAction" }],
        });
      },
      /shared with you/,
    ],
  ];
  for (const [what, setUp, why] of refusals)
    it(`refuses ${what}, naming calendar_respond`, async () => {
      await setUp();
      await sync();
      const res = await accept(await eventId("x"));
      expect(res).toMatchObject({
        status: "error",
        code: "forbidden",
        message: expect.stringMatching(why),
      });
      expect(res).toMatchObject({
        message: expect.stringMatching(/Use calendar_respond; it asks first\.$/),
      });
      expect(patches()).toEqual([]);
      expect(await notes()).toEqual([]);
    });

  it("is Jarvis's alone: you answer with calendar.respond", async () => {
    g.put(ME, invite("standup", SAM));
    await sync();
    const res = await t.kernel.execute(
      "calendar.accept_invite",
      { id: await eventId("standup") },
      ownerCaller(),
    );
    expect(res.status).not.toBe("ok");
    expect(patches()).toEqual([]);
  });

  it("leaves calendar.respond asking, from a turn that read an email or from yours", async () => {
    g.put(ME, invite("standup", SAM));
    await sync();
    const id = await eventId("standup");
    for (const origin of ["untrusted", "owner"] as const) {
      const res = await t.kernel.execute(
        "calendar.respond",
        { id, response: "accepted" },
        jarvisCaller(origin),
      );
      expect(res.status).toBe("pending_approval");
    }
    expect(patches()).toEqual([]);
  });
});

describe("a repeating meeting", () => {
  beforeEach(() => {
    // The series started months ago; Google has it, and sync sees its times in the window.
    g.put(ME, { ...weekly("2026-08-03"), id: "wk", recurringEventId: undefined });
    for (const day of ["2026-10-06", "2026-10-13", "2026-10-20", "2026-10-27", "2026-11-03"])
      g.put(ME, weekly(day));
  });

  it("is accepted for every time when the next 4 weeks are free", async () => {
    busy("later", "2026-11-03"); // past the 4 weeks: not checked
    await sync();
    const id = await eventId("wk_20261006");
    expect(await accept(id)).toMatchObject({ status: "ok" });
    expect(patches()[0]!.path).toMatch(/\/events\/wk$/);
    expect(await notes()).toMatchObject([
      {
        body: `It repeats; you were free every time in the next 4 weeks. Invitation from ${SAM}.`,
        undo: { kind: "unaccept", eventId: id, before: { scope: "all" } },
      },
    ]);
    expect((await row("wk_20261027")).jarvisAccepted).toBe(true);
  });

  it("is refused when any time in the next 4 weeks overlaps", async () => {
    busy("dentist", "2026-10-20");
    await sync();
    const res = await accept(await eventId("wk_20261006"));
    expect(res).toMatchObject({
      status: "error",
      code: "forbidden",
      message: expect.stringMatching(/^It overlaps "Dentist"\./),
    });
    expect(patches()).toEqual([]);
  });

  it("keeps a later time's guests from becoming people too", async () => {
    await sync();
    await accept(await eventId("wk_20261006"));
    g.put(ME, {
      ...weekly("2026-11-10"),
      attendees: [...attendees(SAM, "accepted"), { email: "new@other.example" }],
    });
    await sync();
    expect((await row("wk_20261110")).jarvisAccepted).toBe(true);
    expect(await isPerson("new@other.example")).toBe(false);
  });
});

describe("Undo", () => {
  const accepted = async () => {
    g.put(ME, invite("standup", SAM));
    await sync();
    await accept(await eventId("standup"));
    return (await notes())[0]!;
  };
  const undo = (n: { id: string }, caller: Caller = ownerCaller()) =>
    t.kernel.execute("calendar.undo", { notificationId: n.id }, caller);

  it("sets your answer back to unanswered, once", async () => {
    const n = await accepted();
    expect(await undo(n)).toMatchObject({ status: "ok", result: { undone: "unaccept" } });
    expect(mine(patches().at(-1)!.body)).toBe("needsAction");
    expect(await row("standup")).toMatchObject({
      selfResponse: "needsAction",
      jarvisAccepted: false,
    });
    expect(await notes()).toMatchObject([{ undo: null, state: "done" }]);
    expect(await undo(n)).toMatchObject({ status: "error", code: "not_found" });
  });

  it("won't take back an answer you've given yourself since", async () => {
    const n = await accepted();
    await ok("calendar.respond", { id: await eventId("standup"), response: "declined" });
    expect(await undo(n)).toMatchObject({ status: "error", code: "conflict" });
    expect(mine(patches().at(-1)!.body)).toBe("declined");
  });

  it("is yours to press, not Jarvis's", async () => {
    const n = await accepted();
    expect((await undo(n, jarvis)).status).not.toBe("ok");
    expect(patches()).toHaveLength(1);
  });

  it("is written only by the calendar's own code, never by an action's input", async () => {
    const forged = {
      kind: "unremove",
      eventId: "00000000-0000-4000-8000-000000000000",
      before: { calendarId: ME, title: "Forged", start: "2026-10-06", end: "2026-10-07" },
    };
    const res = await ok<{ id: string }>(
      "inbox.notify",
      { title: "Nothing to see", undo: forged },
      jarvis,
    );
    const [n] = await t.tdb.db.select().from(notification).where(eq(notification.id, res.id));
    expect(n!.undo).toBeNull();
    expect(await undo(n!)).toMatchObject({ status: "error", code: "not_found" });
    // No action takes an undo as input at all.
    const taking = t.kernel.registry
      .allActions()
      .filter((a) => "shape" in a.input && "undo" in (a.input as { shape: object }).shape)
      .map((a) => a.name);
    expect(taking).toEqual([]);
  });
});
