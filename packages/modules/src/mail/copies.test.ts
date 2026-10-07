// The same email to two of your accounts is one message: one conversation, one reply. Each
// account keeps its copy, so reading and archiving reach both Gmails. A Message-ID alone doesn't
// make a copy: anyone who got the email can reuse it.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { company, mailMessage } from "@hearth/db";
import { integrationCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import type { FakeGmail } from "../google/fake-gmail.ts";
import { ALL_MODULES } from "../index.ts";
import { BLOB_SERVICE, BlobStore } from "./blobs.ts";
import type { DraftView } from "./drafts.ts";
import type { ThreadSummary, ThreadView } from "./views.ts";

const HOME = "sam@home.example";
const WORK = "sam@work.example";
const ANA = { address: "ana@friends.example", name: "Ana Silva" };
const MALLORY = { address: "mallory@elsewhere.example", name: "Ana Silva" };
/** Gmail marks it important, so it needs a reply whoever Ana is. */
const IMPORTANT = ["INBOX", "UNREAD", "CATEGORY_PERSONAL", "IMPORTANT"];
const DINNER = {
  from: ANA,
  to: [{ address: HOME }, { address: WORK }],
  subject: "Dinner?",
  text: "Friday at 8?",
  messageId: "dinner-1@friends.example",
  date: new Date(Date.UTC(2026, 9, 1, 9, 30, 15)),
};

let t: TestKernel;
let g: FakeGoogle;
let dir: string;
let home: FakeGmail;
let work: FakeGmail;

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(HOME);
  g.clock = t.clock;
  g.grants = ["openid", "email", ...SCOPES.gmail];
  t.kernel.services[GOOGLE_SERVICE] = g.client();
  dir = await mkdtemp(join(tmpdir(), "hearth-blobs-"));
  t.kernel.services[BLOB_SERVICE] = new BlobStore(dir);
  await connect();
  work = g.addAccount(WORK).gmail;
  g.signingIn = WORK;
  await connect();
  home = g.gmail;
});
afterEach(async () => {
  await t.destroy();
  await rm(dir, { recursive: true, force: true });
});

async function connect() {
  const client = g.client();
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.gmail]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
}
async function ok<T>(name: string, input: unknown = {}, caller = ownerCaller()): Promise<T> {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const sync = () => ok("mail.sync", {}, integrationCaller("google"));
const threads = () => ok<ThreadSummary[]>("mail.threads", { view: "all" });
const senders = async (id: string) =>
  (await ok<ThreadView>("mail.thread", { id })).messages.map((m) => m.from.address);
const flags = (box: FakeGmail, id: string) => box.messages.get(id)!.labelIds;

describe("an email to two of your accounts", () => {
  it("shows once, gets one reply, and reading or archiving it reaches both", async () => {
    const copies = [home.deliver(DINNER, IMPORTANT), work.deliver(DINNER, IMPORTANT)];
    await sync();
    const [thread, ...others] = await threads();
    expect(others).toEqual([]);
    expect(thread).toMatchObject({ subject: "Dinner?", messageCount: 1, waiting: "you" });
    expect(await senders(thread!.id)).toEqual([ANA.address]);
    // Both copies are kept: each account has its own.
    expect(await t.tdb.db.select().from(mailMessage)).toHaveLength(2);

    // A reply goes from the account it came to first, as the conversation shows it.
    const draft = await ok<DraftView>("mail.draft", { threadId: thread!.id, text: "Yes!" });
    expect(draft.account).toBe(thread!.account);
    expect(draft.to.map((a) => a.address)).toEqual([ANA.address]);

    await ok("mail.mark_read", { ids: [thread!.id] });
    await ok("mail.archive", { ids: [thread!.id] });
    await sync();
    for (const [box, id] of [
      [home, copies[0]!],
      [work, copies[1]!],
    ] as const) {
      expect(flags(box, id)).not.toContain("INBOX");
      expect(flags(box, id)).not.toContain("UNREAD");
    }

    // Ana's answer to both joins the conversation once too.
    const again = { ...DINNER, subject: "Re: Dinner?", text: "Or 9?", messageId: "dinner-2@x" };
    const answer = { ...again, inReplyTo: DINNER.messageId, references: [DINNER.messageId] };
    home.deliver(answer, IMPORTANT);
    work.deliver(answer, IMPORTANT);
    await sync();
    expect(await threads()).toMatchObject([{ id: thread!.id, messageCount: 2 }]);
    expect(await senders(thread!.id)).toEqual([ANA.address, ANA.address]);
  });

  it("keeps apart a message that reuses its Message-ID but isn't the same email", async () => {
    home.deliver(DINNER, IMPORTANT);
    // Someone who got it sends their own with its Message-ID to your other account: another
    // sender, or the same sender with another subject or at another time. None is hidden.
    work.deliver({ ...DINNER, from: MALLORY, text: "Pay here" }, IMPORTANT);
    work.deliver({ ...DINNER, subject: "Dinner moved" }, IMPORTANT);
    work.deliver({ ...DINNER, date: new Date(DINNER.date.getTime() + 60_000) }, IMPORTANT);
    await sync();
    const all = await threads();
    expect(all).toHaveLength(2);
    const byAccount = Object.fromEntries(all.map((x) => [x.account, x]));
    expect(await senders(byAccount[HOME]!.id)).toEqual([ANA.address]);
    expect((await senders(byAccount[WORK]!.id)).sort()).toEqual([
      ANA.address,
      ANA.address,
      MALLORY.address,
    ]);
    expect(byAccount[WORK]).toMatchObject({ messageCount: 3 });
  });
});

describe("only the identical email is a copy", () => {
  const EVE = { address: "eve@elsewhere.example" };
  /** Mallory, who got the email, sends your other account her own with the same Message-ID. */
  const forged = (headers: Record<string, string>, more: object = {}) => ({
    ...DINNER,
    ...more,
    headers,
  });
  const byAccount = async () => Object.fromEntries((await threads()).map((x) => [x.account, x]));
  const draftTo = async (threadId: string) => {
    const d = await ok<DraftView>("mail.draft", { threadId, text: "Yes!", replyAll: true });
    return { account: d.account, to: d.to.map((a) => a.address), cc: d.cc.map((a) => a.address) };
  };

  it("keeps apart a forgery a moment later or with its own Reply-To, which never steers a reply", async () => {
    home.deliver(DINNER, IMPORTANT);
    // The same second, .999 of the way through, with her Reply-To and a Cc of her own.
    const late = { Date: "2026-10-01T09:30:15.999Z", "Reply-To": MALLORY.address };
    work.deliver(forged(late, { cc: [EVE] }), IMPORTANT);
    // The same Date to the millisecond, and only her Reply-To added.
    work.deliver(forged({ "Reply-To": MALLORY.address }), IMPORTANT);
    await sync();
    const all = await byAccount();
    expect(all[HOME]).toMatchObject({ messageCount: 1 });
    expect(all[WORK]).toMatchObject({ messageCount: 2 });
    // The reply to the real one goes to Ana alone, from home: neither you nor anyone she added.
    expect(await draftTo(all[HOME]!.id)).toEqual({ account: HOME, to: [ANA.address], cc: [] });
  });

  it("keeps apart a forgery that changes only a name, a list header, what it answers or a file's name", async () => {
    home.deliver(DINNER, IMPORTANT);
    const file = { mimeType: "text/plain", content: Buffer.from("menu") };
    home.deliver(
      {
        ...DINNER,
        messageId: "menu@friends.example",
        attachments: [{ ...file, filename: "menu.txt" }],
      },
      IMPORTANT,
    );
    // Each of these, saved first, would have named the sender, made it bulk mail (no reply
    // needed), pulled it into another conversation, or renamed the file.
    work.deliver({ ...DINNER, from: { ...ANA, name: "Ana (Bank)" } }, IMPORTANT);
    work.deliver(
      { ...DINNER, to: [{ address: HOME, name: "Billing" }, { address: WORK }] },
      IMPORTANT,
    );
    work.deliver(forged({ "List-Unsubscribe": "<mailto:out@elsewhere.example>" }), IMPORTANT);
    work.deliver(
      {
        ...DINNER,
        inReplyTo: "invoice@elsewhere.example",
        references: ["invoice@elsewhere.example"],
      },
      IMPORTANT,
    );
    work.deliver(
      {
        ...DINNER,
        messageId: "menu@friends.example",
        attachments: [{ ...file, filename: "invoice.exe" }],
      },
      IMPORTANT,
    );
    await ok("mail.sync", { account: WORK }, integrationCaller("google"));
    await sync();
    const real = (await threads()).filter((x) => x.account === HOME);
    expect(real.map((x) => x.messageCount)).toEqual([1, 1]);
  });

  it("doesn't hide the real email behind a forgery that came first", async () => {
    work.deliver(forged({ "Reply-To": MALLORY.address }), IMPORTANT);
    await sync();
    home.deliver(DINNER, IMPORTANT);
    work.deliver(DINNER, IMPORTANT);
    await sync();
    const all = await byAccount();
    // The real email shows once, in its own conversation; the forgery stays in its own.
    expect(all[HOME]).toMatchObject({ messageCount: 1 });
    expect(all[WORK]).toMatchObject({ messageCount: 1 });
    expect(await draftTo(all[HOME]!.id)).toMatchObject({ to: [ANA.address] });
  });

  for (const first of [HOME, WORK])
    it(`shows your email to your other account as yours, ${first} saved first`, async () => {
      const BOB = { address: "bob@friends.example" };
      const mine = {
        from: { address: HOME },
        to: [BOB, { address: WORK }],
        subject: "Plans",
        text: "Shall we?",
        messageId: "plans-1@home.example",
        date: DINNER.date,
      };
      home.deliver(mine, ["SENT"]);
      work.deliver(mine, ["INBOX", "UNREAD", "CATEGORY_PERSONAL", "IMPORTANT"]);
      await ok("mail.sync", { account: first }, integrationCaller("google"));
      await sync();
      const [thread, ...others] = await threads();
      expect(others).toEqual([]);
      // Sent, waiting on Bob: not mail to you that needs your reply.
      expect(thread).toMatchObject({ messageCount: 1, waiting: "them", inInbox: false });
      const sent = await ok<ThreadSummary[]>("mail.threads", { view: "sent" });
      expect(sent.map((x) => x.id)).toEqual([thread!.id]);
      expect(await draftTo(thread!.id)).toEqual({ account: HOME, to: [BOB.address], cc: [] });
      // Bob's page counts it once.
      const people = await ok<{ id: string; name: string }[]>("person.list");
      const bob = people.find((p) => p.name === BOB.address);
      const page = await ok<{ threads: { messages: number }[] }>("person.view", { id: bob!.id });
      expect(page.threads).toMatchObject([{ messages: 1 }]);
      // Your other account isn't someone you know: no person, nor a company for its domain.
      expect(people.map((p) => p.name)).not.toContain(WORK);
      const domains = await t.tdb.db.select({ domain: company.domain }).from(company);
      expect(domains.map((c) => c.domain)).not.toContain("work.example");
    });

  it("takes the shown copy's Gmail tab and importance, and either copy's unread or star", async () => {
    home.deliver(DINNER, ["INBOX", "CATEGORY_PERSONAL"]);
    work.deliver(DINNER, ["INBOX", "UNREAD", "STARRED", "CATEGORY_PERSONAL", "IMPORTANT"]);
    await ok("mail.sync", { account: HOME }, integrationCaller("google"));
    await sync();
    // Work's Gmail marks it important; home's, shown, doesn't. Ana's no one you know yet.
    const [thread] = await threads();
    expect(thread).toMatchObject({ messageCount: 1, unread: true, starred: true, waiting: null });
  });

  it("is in the inbox if either copy is, whichever was saved first", async () => {
    await sync();
    home.deliver(DINNER, ["CATEGORY_PERSONAL"]);
    work.deliver(DINNER, IMPORTANT);
    await ok("mail.sync", { account: HOME }, integrationCaller("google"));
    await sync();
    const [thread] = await threads();
    expect(thread).toMatchObject({ messageCount: 1, inInbox: true });
  });

  it("neither announces nor waits on your own email from your other account, before its copy in Sent", async () => {
    const BOB = { address: "bob@friends.example" };
    const mine = { ...DINNER, from: { address: WORK }, to: [{ address: HOME }, BOB] };
    // Synced before, so new mail is news.
    await sync();
    home.deliver(mine, IMPORTANT);
    work.deliver(mine, ["SENT"]);
    // Home saves it first: from work, to home, important. It's still yours.
    await ok("mail.sync", { account: HOME }, integrationCaller("google"));
    expect(await threads()).toMatchObject([{ messageCount: 1, waiting: null }]);
    expect(await t.events("mail.received")).toEqual([]);
    await sync();
    expect(await threads()).toMatchObject([{ messageCount: 1, waiting: "them" }]);
  });

  it("joins an answer that adds your other address to the conversation, whichever saves it", async () => {
    home.deliver({ ...DINNER, to: [{ address: HOME }] }, IMPORTANT);
    await sync();
    const answer = {
      ...DINNER,
      subject: "Re: Dinner?",
      text: "Bringing Sam's colleague too",
      messageId: "dinner-2@friends.example",
      inReplyTo: DINNER.messageId,
      references: [DINNER.messageId],
    };
    work.deliver(answer, IMPORTANT);
    await ok("mail.sync", { account: WORK }, integrationCaller("google"));
    home.deliver(answer, IMPORTANT);
    await sync();
    expect(await threads()).toMatchObject([{ messageCount: 2 }]);
  });

  it("shows once a copy whose Date is ahead of this PC's clock", async () => {
    const ahead = { ...DINNER, date: new Date(Date.UTC(2099, 0, 1)) };
    home.deliver(ahead, IMPORTANT);
    await ok("mail.sync", { account: HOME }, integrationCaller("google"));
    t.clock.advance(60_000);
    work.deliver(ahead, IMPORTANT);
    await sync();
    expect(await threads()).toMatchObject([{ messageCount: 1 }]);
  });
});

describe("disconnecting one of two accounts", () => {
  it("keeps the other's copies, its own replies and its queued changes", async () => {
    home.deliver(DINNER, IMPORTANT);
    const copy = work.deliver(DINNER, IMPORTANT);
    await ok("mail.sync", { account: HOME }, integrationCaller("google"));
    await sync();
    // Ana answers at work only: it joins the conversation home's copy started.
    const answer = {
      ...DINNER,
      to: [{ address: WORK }],
      text: "Or 9?",
      messageId: "dinner-2@x",
      inReplyTo: DINNER.messageId,
      references: [DINNER.messageId],
    };
    const reply = work.deliver(answer, IMPORTANT);
    await sync();
    const [thread] = await threads();
    expect(thread).toMatchObject({ account: HOME, messageCount: 2 });
    // Read in Hearth; the change for work's Gmail waits for the next sync.
    await ok("mail.mark_read", { ids: [thread!.id] });

    await ok("google.disconnect", { email: HOME });
    expect(await threads()).toMatchObject([{ id: thread!.id, account: WORK, messageCount: 2 }]);
    expect(await senders(thread!.id)).toEqual([ANA.address, ANA.address]);
    expect(await t.tdb.db.select().from(mailMessage)).toHaveLength(2);
    await sync();
    expect(flags(work, copy)).not.toContain("UNREAD");
    expect(flags(work, reply)).not.toContain("UNREAD");
  });

  it("takes its mail out of the other's conversations, and works them out again", async () => {
    home.deliver(DINNER, IMPORTANT);
    work.deliver(DINNER, IMPORTANT);
    await ok("mail.sync", { account: WORK }, integrationCaller("google"));
    await sync();
    // Ana answers at home only: it joins the conversation work's copy started.
    home.deliver(
      {
        ...DINNER,
        to: [{ address: HOME }],
        text: "Or 9?",
        messageId: "dinner-2@x",
        inReplyTo: DINNER.messageId,
        references: [DINNER.messageId],
      },
      IMPORTANT,
    );
    await sync();
    const [thread] = await threads();
    expect(thread).toMatchObject({ account: WORK, messageCount: 2 });
    await ok("google.disconnect", { email: HOME });
    expect(await threads()).toMatchObject([{ id: thread!.id, account: WORK, messageCount: 1 }]);
  });

  it("puts the other's copy in its own conversation, when it has that one too", async () => {
    // Something reusing the Message-ID came to work first, so work has a conversation for it.
    work.deliver({ ...DINNER, from: MALLORY, text: "Pay here" }, IMPORTANT);
    home.deliver(DINNER, IMPORTANT);
    work.deliver(DINNER, IMPORTANT);
    await ok("mail.sync", { account: HOME }, integrationCaller("google"));
    await ok("mail.sync", { account: WORK }, integrationCaller("google"));
    expect(await threads()).toHaveLength(2);
    await ok("google.disconnect", { email: HOME });
    const [left, ...others] = await threads();
    expect(others).toEqual([]);
    expect(left).toMatchObject({ account: WORK, messageCount: 2 });
    expect((await senders(left!.id)).sort()).toEqual([ANA.address, MALLORY.address]);
  });
});
