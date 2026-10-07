// Who may accept an invitation without asking (D71), and what: Hearth itself as a new invitation
// comes in (within the day's count, not while Jarvis is paused), or a turn you started; never a
// turn that read outside content. And Jarvis's yes goes only to the invitation as it checked it.
import { calendarEvent, notification } from "@hearth/db";
import {
  type Caller,
  integrationCaller,
  jarvisCaller,
  newId,
  ownerCaller,
  setSetting,
} from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GAttendee } from "../google/calendar-api.ts";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import { AUTO_ACCEPTS } from "./invites.ts";

const ME = "owner@acme.example";
const SAM = "sam@partner.example";

let t: TestKernel;
let g: FakeGoogle;

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const invite = (id: string, day = "2026-10-06", mine = "needsAction", hours = ["15", "16"]) =>
  g.put(ME, {
    id,
    summary: "Standup",
    organizer: { email: SAM },
    attendees: [
      { email: SAM, organizer: true, responseStatus: "accepted" },
      { email: ME, self: true, responseStatus: mine as GAttendee["responseStatus"] },
    ],
    start: { dateTime: `${day}T${hours[0]}:00:00Z` },
    end: { dateTime: `${day}T${hours[1]}:00:00Z` },
  });
const sync = () => ok("calendar.sync", {}, integrationCaller("google"));
const patches = () => g.calls.filter((c) => c.method === "PATCH");
const eventId = async (googleId: string) =>
  (
    await t.tdb.db
      .select({ id: calendarEvent.entityId })
      .from(calendarEvent)
      .where(eq(calendarEvent.googleId, googleId))
  )[0]!.id;
const accept = async (googleId: string, caller: Caller = jarvisCaller("untrusted")) =>
  t.kernel.execute("calendar.accept_invite", { id: await eventId(googleId) }, caller);
const refused = (why: RegExp) => ({
  status: "error",
  code: "forbidden",
  message: expect.stringMatching(why),
});

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(ME);
  g.clock = t.clock;
  t.kernel.services[GOOGLE_SERVICE] = g.client(t.tdb.db);
  const client = g.client(t.tdb.db);
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.calendar]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
  const sam = await ok<{ id: string }>("person.create", { name: "Sam Lee" });
  await ok("person.add_email", { id: sam.id, email: SAM });
  invite("standup");
  await sync();
});
afterEach(() => t.destroy());

describe("who may accept on its own", () => {
  it("never a turn that read outside content: an email can't walk it through old invitations", async () => {
    const turn = jarvisCaller("untrusted", { turnId: newId() });
    expect(await accept("standup", turn)).toMatchObject(
      refused(/^This conversation read outside content\. Use calendar_respond; it asks first\.$/),
    );
    expect(patches()).toEqual([]);
  });

  it("a turn you started, though its notice still carries the sender's words", async () => {
    const turn = jarvisCaller("owner", { turnId: newId() });
    expect(await accept("standup", turn)).toMatchObject({ status: "ok" });
    const notes = await t.tdb.db
      .select()
      .from(notification)
      .where(eq(notification.kind, "calendar.accepted"));
    expect(notes.map((n) => n.outside)).toEqual([true]);
  });

  it("not while Jarvis is paused", async () => {
    await setSetting(t.tdb.db, "jarvis.paused", true);
    expect(await accept("standup")).toMatchObject(refused(/^Jarvis is paused\./));
    expect(patches()).toEqual([]);
  });

  it(`not past ${AUTO_ACCEPTS} a day, counted by the Undo only its own FYIs carry`, async () => {
    const note = (undo: boolean) => ({
      id: newId(),
      kind: "calendar.accepted",
      title: "earlier",
      createdBy: "jarvis",
      createdAt: t.clock.now(),
      ...(undo
        ? {
            undo: {
              kind: "unaccept" as const,
              eventId: newId(),
              before: { scope: "this" as const },
            },
          }
        : {}),
    });
    // Notes of the same kind that anything could write don't count.
    const many = (undo: boolean) => Array.from({ length: AUTO_ACCEPTS }, () => note(undo));
    await t.tdb.db.insert(notification).values(many(false));
    expect(await accept("standup")).toMatchObject({ status: "ok" });
    await t.tdb.db.insert(notification).values(many(true));
    invite("retro", "2026-10-07");
    await sync();
    expect(await accept("retro")).toMatchObject(
      refused(new RegExp(`^Jarvis has accepted ${AUTO_ACCEPTS} invitations on its own today\\.`)),
    );
    expect(patches()).toHaveLength(1);
  });
});

describe("Jarvis's yes goes only to the invitation as it checked it", () => {
  it("not when you've said no on your phone since the last sync", async () => {
    invite("standup", "2026-10-06", "declined");
    expect(await accept("standup")).toMatchObject({ status: "error", code: "conflict" });
    expect(patches()).toEqual([]);
  });

  for (const [what, hours] of [
    ["starts earlier", ["14", "16"]],
    ["ends later", ["15", "17"]],
  ] as const)
    it(`not when it ${what} since, maybe into a clash`, async () => {
      invite("standup", "2026-10-06", "needsAction", [...hours]);
      expect(await accept("standup")).toMatchObject({ status: "error", code: "conflict" });
      expect(patches()).toEqual([]);
    });
});
