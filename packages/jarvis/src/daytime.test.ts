// Jarvis during the day, end to end: an email that needs your reply gets a draft at the next
// heartbeat (never sent), overnight mail is left to the morning drafts, a busy day stops at the
// cap, and a new invitation is accepted when you're free (D71) or becomes one card, without
// spending a model turn.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approval, heartbeatItem, jarvisTurn, notification } from "@hearth/db";
import { type Caller, integrationCaller, jarvisCaller, newId, ownerCaller } from "@hearth/kernel";
import {
  AUTO_ACCEPTS,
  BLOB_SERVICE,
  BlobStore,
  DAYTIME_DRAFTS,
  type DraftView,
  GOOGLE_SERVICE,
  NEEDS_REPLY,
  SCOPES,
  type ThreadSummary,
} from "@hearth/modules";
import { FakeGoogle } from "@hearth/modules/google-testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";

const ME = "owner@example.com";
const ANA = { address: "ana@friends.example", name: "Ana Silva" };
const SAM = { address: "sam@shop.example", name: "Sam Lee" };
const BOSS = "boss@example.com";
const PERSONAL = ["INBOX", "UNREAD", "CATEGORY_PERSONAL", "IMPORTANT"];

let h: JarvisHarness;
let g: FakeGoogle;
let dir: string;

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await h.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const syncMail = () => ok("mail.sync", {}, integrationCaller("google"));
const syncCalendar = () => ok("calendar.sync", {}, integrationCaller("google"));
const items = () => h.tdb.db.select().from(heartbeatItem);
const cards = () => h.tdb.db.select().from(approval);
const accepted = async () =>
  (await h.tdb.db.select().from(notification)).filter((n) => n.kind === "calendar.accepted");
const patches = () => g.calls.filter((c) => c.method === "PATCH");

beforeEach(async () => {
  h = await createJarvisHarness("2026-10-01T14:00:00Z"); // Thursday 10 a.m.
  g = new FakeGoogle(ME);
  g.clock = h.clock;
  g.grants = ["openid", "email", ...SCOPES.gmail, ...SCOPES.calendar];
  h.kernel.services[GOOGLE_SERVICE] = g.client();
  dir = await mkdtemp(join(tmpdir(), "hearth-blobs-"));
  h.kernel.services[BLOB_SERVICE] = new BlobStore(dir);
  const client = g.client();
  const url = new URL(await client.startSignIn(h.tdb.db, [...SCOPES.gmail, ...SCOPES.calendar]));
  await client.finishSignIn(h.tdb.db, url.searchParams.get("state")!, "the-code");
  // The first sync brings in what was already there, quietly.
  await syncMail();
  await h.settle();
});
afterEach(async () => {
  await h.destroy();
  await rm(dir, { recursive: true, force: true });
});

describe("new mail during the day", () => {
  it("drafts a reply at the next heartbeat, and sends nothing", async () => {
    g.gmail.deliver(
      { from: ANA, subject: "Invoice", text: "Can you confirm the total?" },
      PERSONAL,
    );
    await syncMail();
    await h.settle();
    expect(await items()).toMatchObject([
      {
        text: `${NEEDS_REPLY}, from Ana Silva <ana@friends.example>: Invoice`,
        origin: "untrusted",
        takenAt: null,
      },
    ]);
    expect(h.brain.requests).toHaveLength(0);

    const [invoice] = await ok<ThreadSummary[]>("mail.threads", { waiting: "you" });
    h.brain.otherwise((req) =>
      req.prompt.startsWith("Heartbeat.")
        ? [
            { call: "mail_thread", input: { id: invoice!.id } },
            { call: "mail_draft", input: { threadId: invoice!.id, text: "Confirmed: $120." } },
            { say: "Drafted a reply to Ana about the invoice." },
          ]
        : [{ say: "OK." }],
    );
    h.clock.set("2026-10-01T14:25:30Z"); // 10:25: the heartbeat
    await h.settle();

    const beat = h.brain.requests.find((r) => r.prompt.startsWith("Heartbeat."));
    expect(beat?.prompt).toContain("never set to, cc or bcc");
    expect(beat?.prompt).toContain("Invoice");
    const [turn] = (await h.tdb.db.select().from(jarvisTurn)).filter(
      (t) => t.context.routine === "heartbeat",
    );
    expect(turn).toMatchObject({ mode: "proactive", origin: "untrusted", status: "done" });
    expect(await ok<DraftView[]>("mail.drafts")).toMatchObject([
      { threadId: invoice!.id, by: "jarvis", text: "Confirmed: $120." },
    ]);
    expect(g.gmail.sent).toEqual([]);
  });

  it("sets aside one item per conversation, and none once it has a draft", async () => {
    g.gmail.deliver(
      { from: ANA, subject: "Invoice", text: "Total?", messageId: "inv1@f" },
      PERSONAL,
    );
    await syncMail();
    g.gmail.deliver(
      { from: ANA, subject: "Re: Invoice", text: "Also the date?", inReplyTo: "inv1@f" },
      PERSONAL,
    );
    await syncMail();
    await h.settle();
    expect(await items()).toHaveLength(1);
  });

  it("drafts nothing once you've started a reply, and never two drafts of its own", async () => {
    g.gmail.deliver({ from: ANA, subject: "Invoice", text: "Total?" }, PERSONAL);
    await syncMail();
    await h.settle();
    expect(await items()).toHaveLength(1);
    const [invoice] = await ok<ThreadSummary[]>("mail.threads", { waiting: "you" });
    // You opened it and pressed Reply: the reply box is a draft.
    await ok("mail.draft", { threadId: invoice!.id, text: "" });
    h.clock.set("2026-10-01T14:25:30Z");
    await h.settle();
    expect(h.brain.requests).toHaveLength(0);

    const asJarvis = jarvisCaller("untrusted");
    const draft = { threadId: invoice!.id, text: "Confirmed." };
    expect((await h.kernel.execute("mail.draft", draft, asJarvis)).status).toBe("ok");
    expect(await h.kernel.execute("mail.draft", draft, asJarvis)).toMatchObject({
      status: "error",
      code: "conflict",
    });
  });

  it("leaves overnight mail to the morning's reply drafts", async () => {
    h.clock.set("2026-10-02T01:00:00Z"); // 9 p.m.
    g.gmail.deliver({ from: ANA, subject: "Late one", text: "Free tomorrow?" }, PERSONAL);
    await syncMail();
    await h.settle();
    expect(await items()).toEqual([]);
  });

  it(`stops setting mail aside after ${DAYTIME_DRAFTS} in a day`, async () => {
    g.gmail.deliver({ from: ANA, subject: "One", text: "Free?" }, PERSONAL);
    await syncMail();
    await h.settle();
    const [first] = await items();
    await h.tdb.db.insert(heartbeatItem).values(
      Array.from({ length: DAYTIME_DRAFTS - 1 }, () => ({
        id: newId(),
        text: "earlier",
        sourceEventSeq: first!.sourceEventSeq,
      })),
    );
    g.gmail.deliver({ from: SAM, subject: "Two", text: "Ready?" }, PERSONAL);
    await syncMail();
    await h.settle();
    expect(await items()).toHaveLength(DAYTIME_DRAFTS);
  });
});

describe("new invitations", () => {
  const invite = (id: string, summary: string, organizer: string, day = "2026-10-02") => ({
    id,
    summary,
    organizer: { email: organizer },
    attendees: [
      { email: organizer, organizer: true, responseStatus: "accepted" as const },
      { email: ME, self: true, responseStatus: "needsAction" as const },
    ],
    start: { dateTime: `${day}T18:00:00Z` },
    end: { dateTime: `${day}T19:00:00Z` },
  });
  const FROM = `From ${BOSS}.`;

  beforeEach(async () => {
    // Someone you know: you've written to them or met them.
    const boss = await ok<{ id: string }>("person.create", { name: "The Boss" });
    await ok("person.add_email", { id: boss.id, email: BOSS });
  });

  it("is accepted when you're free, and says so with Undo, without a model turn", async () => {
    g.put(ME, invite("design", "Design review", BOSS));
    await syncCalendar();
    await h.settle();
    expect(await cards()).toEqual([]);
    expect(await accepted()).toMatchObject([
      {
        title: expect.stringContaining('"Design review"'),
        createdBy: "jarvis",
        undo: { kind: "unaccept", before: { scope: "this" } },
      },
    ]);
    expect(patches()).toHaveLength(1);
    expect(h.brain.requests).toHaveLength(0);
  });

  it(`becomes one card saying you're free past ${AUTO_ACCEPTS} accepted in a day`, async () => {
    await h.tdb.db.insert(notification).values(
      Array.from({ length: AUTO_ACCEPTS }, () => ({
        id: newId(),
        kind: "calendar.accepted",
        title: "earlier",
        createdBy: "jarvis",
        createdAt: h.clock.now(),
        undo: { kind: "unaccept" as const, eventId: newId(), before: { scope: "this" as const } },
      })),
    );
    g.put(ME, invite("design", "Design review", BOSS));
    await syncCalendar();
    await h.settle();
    expect(await cards()).toMatchObject([
      {
        action: "calendar.respond",
        status: "pending",
        reason: `${FROM} You're free then.`,
        summary: expect.stringContaining('"Design review"'),
      },
    ]);
    expect(patches()).toEqual([]);
  });

  it("leaves an old invitation a calendar's first sync brings as a card", async () => {
    const monthAgo = new Date(h.clock.now().getTime() - 30 * 86_400_000).toISOString();
    g.put(ME, { ...invite("design", "Design review", BOSS), created: monthAgo });
    await syncCalendar();
    await h.settle();
    expect(await cards()).toMatchObject([{ reason: `${FROM} You're free then.` }]);
    expect(await accepted()).toEqual([]);
    expect(patches()).toEqual([]);
  });

  it("becomes the card when accepting it fails", async () => {
    g.put(ME, invite("design", "Design review", BOSS));
    await syncCalendar();
    g.failCalendar(1, 404);
    await h.settle();
    expect(await cards()).toMatchObject([{ reason: `${FROM} You're free then.` }]);
    expect(await accepted()).toEqual([]);
    expect(patches()).toEqual([]);
  });

  it("names what it overlaps", async () => {
    g.put(ME, {
      id: "lunch",
      summary: "Lunch with Ana",
      start: { dateTime: "2026-10-02T18:30:00Z" },
      end: { dateTime: "2026-10-02T19:30:00Z" },
    });
    g.put(ME, invite("design", "Design review", BOSS));
    await syncCalendar();
    await h.settle();
    expect(await cards()).toMatchObject([{ reason: `${FROM} It overlaps "Lunch with Ana".` }]);
    expect(patches()).toEqual([]);
  });

  it("checks a whole day for an all-day invitation, and not the meeting's own copies", async () => {
    g.addCalendar({ id: "family@group.example", summary: "Family", accessRole: "owner" });
    g.put(ME, {
      id: "lunch",
      summary: "Lunch with Ana",
      start: { dateTime: "2026-10-02T16:30:00Z" },
      end: { dateTime: "2026-10-02T17:30:00Z" },
    });
    g.put(ME, {
      ...invite("offsite", "Offsite", BOSS),
      start: { date: "2026-10-02" },
      end: { date: "2026-10-03" },
    });
    g.put(ME, { ...invite("design", "Design review", BOSS, "2026-10-05"), iCalUID: "dr@x" });
    g.put("family@group.example", {
      ...invite("design-copy", "Design review", BOSS, "2026-10-05"),
      iCalUID: "dr@x",
    });
    await syncCalendar();
    await h.settle();
    // The all-day one overlaps lunch; the other's copy on Family doesn't count against it.
    expect((await cards()).map((c) => c.reason)).toEqual([`${FROM} It overlaps "Lunch with Ana".`]);
    expect(await accepted()).toMatchObject([{ title: expect.stringContaining('"Design review"') }]);
  });

  it("makes no card for an invitation on a calendar shared with you", async () => {
    // Shared with you with full rights: Google's "you" on it is its owner.
    g.addCalendar({ id: "partner@example.com", summary: "Partner", accessRole: "owner" });
    g.put("partner@example.com", {
      id: "theirs",
      summary: "Their dentist",
      organizer: { email: BOSS },
      attendees: [
        { email: BOSS, organizer: true, responseStatus: "accepted" as const },
        { email: "partner@example.com", self: true, responseStatus: "needsAction" as const },
      ],
      start: { dateTime: "2026-10-02T18:00:00Z" },
      end: { dateTime: "2026-10-02T19:00:00Z" },
    });
    await syncCalendar();
    await h.settle();
    expect(await cards()).toEqual([]);
    expect(patches()).toEqual([]);
  });

  it("does nothing with a stranger's invitation", async () => {
    g.put(ME, invite("spam", "Claim your prize", "promo@prizes.example"));
    await syncCalendar();
    await h.settle();
    expect(await cards()).toEqual([]);
    expect(patches()).toEqual([]);
  });

  describe("a repeating meeting", () => {
    beforeEach(() => {
      // Google has the series itself, from before the window sync reads; sync sees its times.
      g.put(ME, invite("wk", "Weekly sync", BOSS, "2026-09-03"));
      g.put(ME, { ...invite("wk_1", "Weekly sync", BOSS), recurringEventId: "wk" });
      g.put(ME, { ...invite("wk_2", "Weekly sync", BOSS, "2026-10-09"), recurringEventId: "wk" });
    });

    it("is accepted once, for every time, when you're free every time", async () => {
      await syncCalendar();
      await h.settle();
      expect(await cards()).toEqual([]);
      expect(await accepted()).toMatchObject([{ undo: { before: { scope: "all" } } }]);
      expect(patches()).toMatchObject([{ path: expect.stringMatching(/\/events\/wk$/) }]);
    });

    it("asks once, for every time, when one of them overlaps", async () => {
      g.put(ME, {
        id: "lunch",
        summary: "Lunch with Ana",
        start: { dateTime: "2026-10-09T18:30:00Z" },
        end: { dateTime: "2026-10-09T19:30:00Z" },
      });
      await syncCalendar();
      await h.settle();
      const all = await cards();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        input: { response: "accepted", scope: "all" },
        reason: `${FROM} It repeats; 1 of the next 2 times overlap, first "Lunch with Ana".`,
      });
      expect(patches()).toEqual([]);
    });
  });

  it("neither accepts nor asks while Jarvis is paused", async () => {
    await ok("jarvis.pause", {});
    g.put(ME, invite("design", "Design review", BOSS));
    await syncCalendar();
    await h.settle();
    expect(await cards()).toEqual([]);
    expect(await accepted()).toEqual([]);
    expect(patches()).toEqual([]);
  });
});
