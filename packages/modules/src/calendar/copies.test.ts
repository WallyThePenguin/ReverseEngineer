// A meeting that reaches two of your addresses is listed once (D61): as the copy you organize, so
// Jarvis can change it, else the one you said yes to, the same copy on every read, and its prep and
// notes found from whichever copy has them.
import { integrationCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GAttendee, GEvent } from "../google/calendar-api.ts";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import { type Copy, oneEach } from "./copies.ts";

const ME = "owner@example.com";
const WORK = "work@example.com";
const ANA = "ana@example.com";
const RANGE = { from: "2026-10-01T00:00:00Z", to: "2026-10-12T00:00:00Z" };

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

const run = async <T>(action: string, input: unknown = {}) => {
  const res = await t.kernel.execute<T>(action, input, ownerCaller());
  if (res.status !== "ok") throw new Error(JSON.stringify(res));
  return res.result;
};
const sync = () => t.kernel.execute("calendar.sync", {}, integrationCaller("google"));
const at = (iso: string) => ({ dateTime: iso });

interface Listed {
  id: string;
  title: string;
  selfOrganizer: boolean;
  selfResponse: string | null;
  status: string;
  prepId?: string;
}
const listed = async (more: object = {}) =>
  (await run<Listed[]>("calendar.events", { ...RANGE, ...more })).filter(
    (e) => e.title === "Design sync",
  );
const calendarRow = async (account: string, googleId: string) =>
  (
    await run<{ calendars: { id: string; account: string; googleId: string }[] }>(
      "calendar.calendars",
    )
  ).calendars.find((c) => c.account === account && c.googleId === googleId)!;

/** An invitation to "Design sync" at one of your addresses. */
const invitation = (self: string, response: GAttendee["responseStatus"], organizer = ANA) => ({
  summary: "Design sync",
  iCalUID: "design-1@google.com",
  start: at("2026-10-02T16:00:00Z"),
  end: at("2026-10-02T17:00:00Z"),
  organizer: { email: organizer },
  attendees: [
    { email: organizer, organizer: true, responseStatus: "accepted" as const },
    { email: self, self: true, responseStatus: response },
  ],
});

/** Jarvis schedules "Design sync" with Ana and your work address; work says yes. */
async function scheduleWithWork(calendarId: string) {
  await run("calendar.schedule_meeting", {
    title: "Design sync",
    start: "2026-10-02T16:00:00Z",
    end: "2026-10-02T17:00:00Z",
    attendees: [ANA, WORK],
  });
  const made = [...g.calendars.get(calendarId)!.events.values()].find(
    (e) => e.summary === "Design sync",
  ) as GEvent;
  made.iCalUID = "design-1@google.com";
  g.put(WORK, invitation(WORK, "accepted", ME));
  await sync();
}

describe("a meeting at two of your addresses", () => {
  it("shows the copy you organize, which Jarvis can move", async () => {
    await sync();
    await scheduleWithWork(ME);
    const [shown, ...more] = await listed();
    expect(more).toEqual([]);
    expect(shown).toMatchObject({ selfOrganizer: true, selfResponse: null });
    await run("calendar.update_meeting", {
      id: shown!.id,
      start: "2026-10-02T18:00:00Z",
      end: "2026-10-02T19:00:00Z",
    });
  });

  it("counts the calendar new events go to as yours", async () => {
    g.shareCalendar({ id: "side", summary: "Side projects" }, { [ME]: "owner" });
    await sync();
    await run("calendar.set_default", { id: (await calendarRow(ME, "side")).id });
    await scheduleWithWork("side");
    const [shown] = await listed();
    expect(shown).toMatchObject({ selfOrganizer: true });
  });

  it("shows your invitation over a colleague's copy on a calendar you can write to", async () => {
    g.shareCalendar({ id: ANA, summary: "Ana" }, { [ME]: "writer" });
    const hers = invitation(ANA, "accepted");
    g.put(ANA, { ...hers, organizer: { email: ANA, self: true } });
    g.put(ME, invitation(ME, "needsAction"));
    await sync();
    await run("calendar.choose", { id: (await calendarRow(ME, ANA)).id, selected: true });
    await sync();
    expect(await listed()).toMatchObject([{ selfOrganizer: false, selfResponse: "needsAction" }]);
  });

  it("says a meeting is cancelled only when every copy is", async () => {
    g.put(ME, invitation(ME, "needsAction"));
    const work = g.put(WORK, invitation(WORK, "accepted"));
    await sync();
    g.remove(WORK, work.id);
    await sync();
    expect(await listed({ includeCancelled: true })).toMatchObject([
      { status: "confirmed", selfResponse: "needsAction" },
    ]);
  });

  it("finds the prep and notes made on the copy that isn't shown", async () => {
    g.put(ME, invitation(ME, "needsAction"));
    await sync();
    const [first] = await listed();
    const prep = await run<{ id: string }>("prep.publish", {
      eventId: first!.id,
      markdown: "Bring the mockups.",
    });
    const notes = await run<{ id: string }>("meeting.start", { eventId: first!.id });
    g.put(WORK, invitation(WORK, "accepted"));
    await sync();
    const [shown] = await listed();
    expect(shown).toMatchObject({ selfResponse: "accepted", prepId: prep.id });
    expect(shown!.id).not.toBe(first!.id);
    expect(await run("calendar.get", { id: shown!.id })).toMatchObject({ prepId: prep.id });
    expect(await run("meeting.start", { eventId: shown!.id })).toEqual(notes);
  });
});

describe("oneEach", () => {
  const copy = (id: string, own: string | null): Copy => ({
    e: { id },
    r: {
      icalUid: "x",
      googleId: id,
      startsAt: new Date("2026-10-02T16:00:00Z"),
      selfResponse: "accepted",
      selfOrganizer: false,
      status: "confirmed",
    },
    own,
    writeDefault: false,
  });

  it("shows the same copy of a tie whatever order the rows come in", () => {
    const rows = [copy("b", ME), copy("a", WORK)];
    expect(oneEach(rows)[0]!.shown.e.id).toBe("a");
    expect(oneEach(rows.reverse())[0]!.shown.e.id).toBe("a");
  });
});
