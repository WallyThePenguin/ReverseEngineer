// When a heartbeat turn doesn't finish: emails it never reached come back at the next heartbeat,
// the ones it drafted or made a task of don't, and anything else it took stays taken. Also, the
// owner starting a reply mid-turn wins, a sender's fast clock can't earn a second draft, and an
// invitation to another of the owner's accounts still gets its card.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approval,
  googleAccount,
  heartbeatItem,
  jarvisTurn,
  mailThread,
  notification,
} from "@hearth/db";
import { type Caller, integrationCaller, newId, ownerCaller } from "@hearth/kernel";
import {
  BLOB_SERVICE,
  BlobStore,
  type DraftView,
  GOOGLE_SERVICE,
  SCOPES,
  SLACK_FOR_YOU,
  type ThreadSummary,
} from "@hearth/modules";
import { FakeGoogle } from "@hearth/modules/google-testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";

const ME = "owner@example.com";
const ANA = { address: "ana@friends.example", name: "Ana Silva" };
const SAM = { address: "sam@shop.example", name: "Sam Lee" };
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
const beats = () => h.brain.requests.filter((r) => r.prompt.startsWith("Heartbeat."));
const items = () => h.tdb.db.select().from(heartbeatItem);
async function twoEmails() {
  g.gmail.deliver({ from: ANA, subject: "Invoice", text: "Can you confirm?" }, PERSONAL);
  g.gmail.deliver({ from: SAM, subject: "Delivery", text: "Which day?" }, PERSONAL);
  await syncMail();
  await h.settle();
  const threads = await ok<ThreadSummary[]>("mail.threads", { waiting: "you" });
  return Object.fromEntries(threads.map((t) => [t.subject, t.id])) as Record<string, string>;
}
/** Something set aside that the heartbeat doesn't check again before a turn. */
async function otherItem() {
  const [first] = await items();
  await h.tdb.db
    .insert(heartbeatItem)
    .values({ id: newId(), text: "A note to look at", sourceEventSeq: first!.sourceEventSeq });
}

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
  await syncMail();
  await h.settle();
});
afterEach(async () => {
  await h.destroy();
  await rm(dir, { recursive: true, force: true });
});

describe("a heartbeat turn that doesn't finish", () => {
  it("gives the next heartbeat the emails it never reached, and nothing twice", async () => {
    const id = await twoEmails();
    await otherItem();
    h.brain.next([
      { call: "mail_draft", input: { threadId: id.Invoice, text: "Confirmed." } },
      { call: "no_such_tool", input: {} }, // the turn fails here
    ]);
    h.clock.set("2026-10-01T14:25:30Z");
    await h.settle();
    const [failed] = await h.tdb.db.select().from(jarvisTurn);
    expect(failed).toMatchObject({ status: "failed" });
    const other = (await items()).find((i) => i.text === "A note to look at");
    expect(other?.takenAt).not.toBeNull();

    h.clock.set("2026-10-01T14:50:30Z");
    await h.settle();
    expect(beats()).toHaveLength(2);
    expect(beats()[1]!.prompt).toContain("Delivery");
    expect(beats()[1]!.prompt).not.toContain("Invoice");
    expect(beats()[1]!.prompt).not.toContain("A note to look at");
  });

  it("after a restart mid-turn, offers an email again only if it got nothing", async () => {
    const id = await twoEmails();
    await otherItem();
    const ref = `<m-ref type="email_thread" id="${id.Invoice}">the email</m-ref>`;
    h.brain.next([
      { call: "task_create", input: { title: "Confirm the invoice", body: ref } },
      { say: "" },
    ]);
    h.clock.set("2026-10-01T14:25:30Z");
    await h.settle();
    // As if Jarvis stopped for an update right after the task, before drafting anything.
    await h.tdb.db.update(jarvisTurn).set({ status: "running", finishedAt: null });
    await h.runner.recoverInterrupted();
    const other = (await items()).find((i) => i.text === "A note to look at");
    expect(other?.takenAt).not.toBeNull();

    h.clock.set("2026-10-01T14:50:30Z");
    await h.settle();
    expect(beats()[1]?.prompt).toContain("Delivery");
    expect(beats()[1]?.prompt).not.toContain("Invoice");
  });
});

describe("a heartbeat turn that added an event, then failed", () => {
  it("puts back only its Slack messages, so the event isn't made twice", async () => {
    await ok("calendar.sync", {}, integrationCaller("google"));
    const id = await twoEmails();
    const [first] = await items();
    const slack = `${SLACK_FOR_YOU}: Eve in a direct message`;
    await h.tdb.db
      .insert(heartbeatItem)
      .values({ id: newId(), text: slack, sourceEventSeq: first!.sourceEventSeq });
    const event = {
      title: "Dentist",
      start: "2026-10-05T10:00:00-04:00",
      end: "2026-10-05T11:00:00-04:00",
    };
    h.brain.next([
      { call: "calendar_create_event", input: event },
      { call: "no_such_tool", input: {} },
    ]);
    h.clock.set("2026-10-01T14:25:30Z");
    await h.settle();
    expect(id.Delivery).toBeTruthy();
    expect((await items()).filter((i) => !i.takenAt).map((i) => i.text)).toEqual([slack]);
    h.clock.set("2026-10-01T14:50:30Z");
    await h.settle();
    expect(beats()).toHaveLength(2);
    expect(beats()[1]?.prompt).toContain(slack);
    expect(beats()[1]?.prompt).not.toContain("Invoice");
    expect(beats()[1]?.prompt).not.toContain("Delivery");
  });
});

describe("drafting on its own", () => {
  it("leaves a conversation the owner started a reply to mid-turn", async () => {
    const id = await twoEmails();
    h.brain.next(async () => {
      await ok("mail.draft", { threadId: id.Invoice, text: "" }); // the owner presses Reply
      return [
        { call: "mail_draft", input: { threadId: id.Invoice, text: "Confirmed." } },
        { call: "mail_draft", input: { threadId: id.Delivery, text: "Tuesday [which time?]" } },
        { say: "" },
      ];
    });
    h.clock.set("2026-10-01T14:25:30Z");
    await h.settle();
    const drafts = await ok<DraftView[]>("mail.drafts");
    expect(drafts.map((d) => [d.threadId === id.Invoice ? "Invoice" : "Delivery", d.by])).toEqual(
      expect.arrayContaining([
        ["Invoice", "owner"],
        ["Delivery", "jarvis"],
      ]),
    );
    expect(drafts).toHaveLength(2);
  });

  it("dates a message from a fast clock no later than it arrived", async () => {
    g.gmail.deliver(
      {
        from: ANA,
        subject: "From the future",
        text: "Hi?",
        date: new Date("2026-10-01T15:00:00Z"),
      },
      PERSONAL,
    );
    await syncMail();
    const [t] = await h.tdb.db.select().from(mailThread).where(eq(mailThread.waiting, "you"));
    expect(t?.waitingSince?.toISOString()).toBe("2026-10-01T14:00:00.000Z");
  });
});

describe("invitations to another account of yours", () => {
  it("are yours to answer when that account's calendar syncs through this one", async () => {
    const WORK = "work@example.com";
    await h.tdb.db.insert(googleAccount).values({ email: WORK, refreshToken: "rt2" });
    const boss = await ok<{ id: string }>("person.create", { name: "The Boss" });
    await ok("person.add_email", { id: boss.id, email: "boss@example.com" });
    g.addCalendar({ id: WORK, summary: "Work", accessRole: "owner" });
    g.put(WORK, {
      id: "standup",
      summary: "Standup",
      organizer: { email: "boss@example.com" },
      attendees: [
        { email: "boss@example.com", organizer: true, responseStatus: "accepted" as const },
        { email: WORK, self: true, responseStatus: "needsAction" as const },
      ],
      start: { dateTime: "2026-10-02T18:00:00Z" },
      end: { dateTime: "2026-10-02T19:00:00Z" },
    });
    await ok("calendar.sync", {}, integrationCaller("google"));
    await h.settle();
    // From someone you know, and you're free: Jarvis accepts it for you (D71).
    expect(await h.tdb.db.select().from(approval)).toEqual([]);
    expect(await h.tdb.db.select().from(notification)).toMatchObject([
      { kind: "calendar.accepted", title: expect.stringContaining('"Standup"') },
    ]);
  });
});
