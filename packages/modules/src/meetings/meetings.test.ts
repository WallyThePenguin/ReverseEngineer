import { entity } from "@hearth/db";
import {
  type Caller,
  type HearthEvent,
  integrationCaller,
  jarvisCaller,
  ownerCaller,
} from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepRoutine } from "../calendar/prep.ts";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import { meetingsModule } from "./index.ts";

const ME = "owner@example.com";
const CAROL = "carol@beta.example";

let t: TestKernel;
let g: FakeGoogle;

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(ME);
  g.grants = ["openid", "email", ...SCOPES.calendar];
  t.kernel.services[GOOGLE_SERVICE] = g.client();
  const client = g.client();
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.calendar]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
});
afterEach(() => t.destroy());

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}

/** A meeting with Carol that you accepted, synced in. Returns its event id. */
async function meetingWithCarol(summary: string, start: string, end: string) {
  g.put(ME, {
    summary,
    start: { dateTime: start },
    end: { dateTime: end },
    attendees: [
      { email: ME, self: true, responseStatus: "accepted" },
      { email: CAROL, displayName: "Carol" },
    ],
  });
  await ok("calendar.sync", {}, integrationCaller("google"));
  const events = await ok<{ id: string; title: string }[]>("calendar.events", {
    from: "2026-09-20T00:00:00Z",
    to: "2026-10-20T00:00:00Z",
  });
  return events.find((e) => e.title === summary)!.id;
}

interface Meeting {
  id: string;
  people: { name: string }[];
  event: { id: string } | null;
  summary: string | null;
  tasks: { id: string; title: string }[];
  segments: { id: string; text: string }[];
}
const get = (id: string) => ok<Meeting>("meeting.get", { id, segments: true });
const firing = () => ({
  scheduledFor: t.clock.now(),
  event: {} as HearthEvent,
  digest: async () => [],
});

describe("meeting notes", () => {
  it("takes notes for an event, linked to it and the people in it", async () => {
    const eventId = await meetingWithCarol(
      "Budget",
      "2026-10-01T13:00:00Z",
      "2026-10-01T15:00:00Z",
    );
    const { id } = await ok<{ id: string }>("meeting.start", { eventId });
    expect(await ok<{ id: string }>("meeting.start", { eventId })).toEqual({ id });
    expect(await get(id)).toMatchObject({
      event: { id: eventId },
      people: [{ name: "Carol" }],
      summary: null,
    });
  });

  it("keeps one copy of each transcript segment, however often it's sent", async () => {
    const { id } = await ok<{ id: string }>("meeting.start", { title: "Call" });
    const seg = { id: "them:1000", channel: "them", startMs: 1000, endMs: 3000, text: "Hi" };
    await ok("meeting.add_segments", { id, segments: [seg] });
    await ok("meeting.add_segments", {
      id,
      segments: [
        { ...seg, text: "Hi there" },
        { ...seg, id: "me:0", channel: "me", startMs: 0 },
      ],
    });
    expect((await get(id)).segments.map((s) => [s.id, s.text])).toEqual([
      ["me:0", "Hi"],
      ["them:1000", "Hi there"],
    ]);
    // Jarvis never writes the transcript.
    expect(
      await t.kernel.execute(
        "meeting.add_segments",
        { id, segments: [seg] },
        jarvisCaller("agent"),
      ),
    ).toMatchObject({ status: "denied" });
    // Once it has ended, nothing rewrites what was said.
    await ok("meeting.end", { id });
    expect(
      await t.kernel.execute(
        "meeting.add_segments",
        { id, segments: [{ ...seg, text: "Something else" }] },
        ownerCaller(),
      ),
    ).toMatchObject({ status: "error", code: "conflict" });
  });

  it("asks Jarvis for a summary when it ends, untrusted, and turns action items into tasks once", async () => {
    const empty = await ok<{ id: string }>("meeting.start", { title: "Nothing said" });
    await ok("meeting.end", { id: empty.id });
    expect(await t.events("meeting.ended")).toEqual([]);

    const { id } = await ok<{ id: string }>("meeting.start", { title: "Planning" });
    await ok("meeting.update", { id, notes: "Carol owns the budget." });
    await ok("meeting.end", { id });
    await ok("meeting.end", { id });
    const ended = await t.events("meeting.ended");
    expect(ended).toHaveLength(1);
    const [turn] = await meetingsModule.reflexes[0]!.run(ended[0]!, {
      db: t.tdb.db,
      now: t.clock.now(),
    });
    expect(turn).toMatchObject({ kind: "turn", untrusted: true, subjectId: id });

    const jarvis = jarvisCaller("agent");
    const publish = {
      id,
      summary: "Budget agreed.",
      actionItems: ["Send the deck", "Book a room"],
    };
    await ok("meeting.publish_summary", publish, jarvis);
    await ok("meeting.publish_summary", { ...publish, actionItems: ["send the deck"] }, jarvis);
    expect(await get(id)).toMatchObject({
      summary: "Budget agreed.",
      tasks: [{ title: "Send the deck" }, { title: "Book a room" }],
    });
    // The task titles came from what people said, so they're outside content.
    const [made] = (await get(id)).tasks;
    const rows = await t.tdb.db.select().from(entity).where(eq(entity.id, made!.id));
    expect(rows[0]?.createdBy).toBe("integration:meetings");
    // A turn that read outside content can't rewrite a summary, or start or change notes.
    const untrusted = { ...jarvis, origin: "untrusted" as const };
    expect(
      await t.kernel.execute("meeting.publish_summary", { id, summary: "Fake" }, untrusted),
    ).toMatchObject({ status: "error", code: "conflict" });
    expect(
      await t.kernel.execute("meeting.update", { id, notes: "Fake" }, untrusted),
    ).toMatchObject({ status: "pending_approval" });
    expect(
      await t.kernel.execute("meeting.start", { title: "Fake", peopleIds: [made!.id] }, untrusted),
    ).toMatchObject({ status: "pending_approval" });
    const notPeople = await ok<{ id: string }>("meeting.start", {
      title: "X",
      peopleIds: [made!.id],
    });
    expect((await get(notPeople.id)).people).toEqual([]);
  });

  it("puts the last meeting with the same people in tomorrow's prep, by itself", async () => {
    const first = await meetingWithCarol("Budget", "2026-10-01T13:00:00Z", "2026-10-01T13:30:00Z");
    const { id } = await ok<{ id: string }>("meeting.start", { eventId: first });
    await ok("meeting.update", { id, notes: "Carol wants numbers by Friday." });
    await ok("meeting.publish_summary", { id, summary: "Agreed to cut travel by 10%." });
    // A different meeting with Carol tomorrow.
    await meetingWithCarol("Hiring sync", "2026-10-02T15:00:00Z", "2026-10-02T16:00:00Z");
    t.clock.set("2026-10-02T10:00:00Z");
    const [turn] = await prepRoutine.run(firing(), { db: t.tdb.db, now: t.clock.now() });
    expect(turn).toMatchObject({ kind: "turn", untrusted: true });
    const facts = (turn as { prompt: string }).prompt;
    expect(facts).toContain('Last meeting with them: "Budget"');
    expect(facts).toContain("Agreed to cut travel by 10%.");
    expect(facts).toContain("Carol wants numbers by Friday.");
    // Jarvis paused: the plain packet carries the same notes.
    const fallback = (turn as { fallback: { input: { markdown: string } }[] }).fallback;
    expect(fallback[0]!.input.markdown).toContain("Agreed to cut travel by 10%.");
  });

  it("keeps your notes out of a stranger's invitation that names the same meeting and people", async () => {
    const first = await meetingWithCarol("Budget", "2026-10-01T13:00:00Z", "2026-10-01T13:30:00Z");
    const { id } = await ok<{ id: string }>("meeting.start", { eventId: first });
    await ok("meeting.publish_summary", { id, summary: "Private numbers." });
    g.put(ME, {
      summary: "Budget",
      start: { dateTime: "2026-10-02T15:00:00Z" },
      end: { dateTime: "2026-10-02T16:00:00Z" },
      organizer: { email: "x@evil.example" },
      attendees: [
        { email: ME, self: true, responseStatus: "needsAction" },
        { email: "x@evil.example", displayName: "Carol", organizer: true },
      ],
    });
    await ok("calendar.sync", {}, integrationCaller("google"));
    t.clock.set("2026-10-02T10:00:00Z");
    const [turn] = await prepRoutine.run(firing(), { db: t.tdb.db, now: t.clock.now() });
    expect((turn as { prompt: string }).prompt).not.toContain("Private numbers.");
  });

  it("records into the meeting that's on now, or notes you opened, or a new one", async () => {
    const eventId = await meetingWithCarol(
      "Budget",
      "2026-10-01T13:00:00Z",
      "2026-10-01T14:00:00Z",
    );
    type Rec = { id: string; title: string; offsetMs: number };
    const record = (title?: string) => ok<Rec>("meeting.record", title ? { title } : {});

    // Five minutes before it starts, it's the one; times count from when recording began.
    t.clock.set("2026-10-01T12:55:00Z");
    const early = await record();
    expect(early).toMatchObject({ title: "Budget", offsetMs: 0 });
    t.clock.set("2026-10-01T13:10:00Z");
    expect(await record()).toEqual({ ...early, offsetMs: 15 * 60_000 });
    expect(await get(early.id)).toMatchObject({
      event: { id: eventId },
      people: [{ name: "Carol" }],
    });

    // Once it's ended, recording again makes a second meeting with the same people.
    await ok("meeting.end", { id: early.id });
    const again = await record();
    expect(again.id).not.toBe(early.id);
    expect(await get(again.id)).toMatchObject({ event: null, people: [{ name: "Carol" }] });
    await ok("meeting.end", { id: again.id });

    // Nothing on the calendar: notes you just opened, else a new meeting.
    t.clock.set("2026-10-01T16:00:00Z");
    const { id: opened } = await ok<{ id: string }>("meeting.start", { title: "Standup" });
    expect((await record()).id).toBe(opened);
    await ok("meeting.end", { id: opened });
    const fresh = await record("Quick sync");
    expect(fresh).toMatchObject({ title: "Quick sync", offsetMs: 0 });
    expect(fresh.id).not.toBe(opened);
  });
});
