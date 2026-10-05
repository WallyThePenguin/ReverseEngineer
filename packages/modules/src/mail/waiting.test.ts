import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mailThread } from "@hearth/db";
import {
  type Caller,
  type HearthEvent,
  integrationCaller,
  jarvisCaller,
  ownerCaller,
  setSetting,
} from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import { BLOB_SERVICE, BlobStore } from "./blobs.ts";
import type { ThreadSummary } from "./views.ts";
import { followUpRoutine, REPLY_DRAFTS, replyDraftRoutine, waitingDigest } from "./waiting.ts";

const ME = "owner@example.com";
const ANA = { address: "ana@friends.example", name: "Ana Silva" };

let t: TestKernel;
let g: FakeGoogle;
let dir: string;

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  t.clock.set("2026-10-01T13:00:00Z");
  g = new FakeGoogle(ME);
  g.grants = ["openid", "email", ...SCOPES.gmail];
  t.kernel.services[GOOGLE_SERVICE] = g.client();
  dir = await mkdtemp(join(tmpdir(), "hearth-blobs-"));
  t.kernel.services[BLOB_SERVICE] = new BlobStore(dir);
  const client = g.client();
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.gmail]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
});
afterEach(async () => {
  await t.destroy();
  await rm(dir, { recursive: true, force: true });
});

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const sync = () => ok("mail.sync", {}, integrationCaller("google"));
const waiting = async (w: "you" | "them") =>
  (await ok<ThreadSummary[]>("mail.threads", { view: "all", waiting: w })).map((x) => x.subject);
/** Gmail marks it important: from someone Hearth doesn't know yet, that's what flags it. */
const IMPORTANT = ["INBOX", "UNREAD", "CATEGORY_PERSONAL", "IMPORTANT"];

function seed() {
  g.gmail.deliver({ from: ANA, subject: "Dinner?", text: "Are you free Friday?" }, IMPORTANT);
  g.gmail.deliver({
    from: ANA,
    cc: [],
    to: [{ address: "team@x.example" }],
    subject: "FYI",
    text: ".",
  });
  // Someone Hearth doesn't know, and Gmail doesn't think it's important.
  g.gmail.deliver({ from: { address: "cy@else.example" }, subject: "Quick question", text: "?" });
  g.gmail.deliver({ from: { address: "no-reply@shop.example" }, subject: "Receipt", text: "." });
  g.gmail.deliver({ from: { address: "bo@x.example" }, subject: "Sale", text: "." }, [
    "INBOX",
    "CATEGORY_PROMOTIONS",
  ]);
  g.gmail.deliver(
    {
      from: { address: ME },
      to: [{ address: "bo@x.example" }],
      subject: "Contract",
      text: "Did you sign it?",
    },
    ["SENT"],
  );
}

describe("needs a reply, and waiting on them", () => {
  it("knows which mail is a person writing to you, and which you're waiting on", async () => {
    seed();
    await sync();
    expect(await waiting("you")).toEqual(["Dinner?"]);
    expect(await waiting("them")).toEqual(["Contract"]);
    // The receipt and the stranger's question are unread Signal, but don't need your reply.
    expect(await ok("mail.counts")).toEqual({ unread: 4, toReply: 1 });
  });

  it("matches what the migration worked out for mail already here", async () => {
    seed();
    await sync();
    const before = await t.tdb.db.select().from(mailThread).orderBy(mailThread.entityId);
    await t.tdb.db.update(mailThread).set({ waiting: null, waitingSince: null });
    const up = await readFile(
      new URL("../../../db/migrations/0008_mail_waiting.up.sql", import.meta.url),
      "utf8",
    );
    await t.tdb.db.execute(sql.raw(up.slice(up.indexOf("UPDATE mail_thread"))));
    // And 0032's second look, for a known sender or Gmail's important mark.
    const v32 = await readFile(
      new URL("../../../db/migrations/0032_integrations.up.sql", import.meta.url),
      "utf8",
    );
    const from = v32.indexOf("UPDATE mail_thread t SET waiting = NULL");
    await t.tdb.db.execute(sql.raw(v32.slice(from, v32.indexOf(";", from) + 1)));
    const after = await t.tdb.db.select().from(mailThread).orderBy(mailThread.entityId);
    expect(after.map((x) => [x.waiting, x.waitingSince])).toEqual(
      before.map((x) => [x.waiting, x.waitingSince]),
    );
  });

  it("drops off when you reply or say no reply is needed, and comes back with a new message", async () => {
    g.gmail.deliver(
      { from: ANA, subject: "Dinner?", text: "Are you free Friday?", messageId: "d1@f" },
      IMPORTANT,
    );
    await sync();
    const [x] = await ok<ThreadSummary[]>("mail.threads", { waiting: "you" });
    await ok("mail.no_reply", { ids: [x!.id] });
    expect(await waiting("you")).toEqual([]);
    g.gmail.deliver(
      {
        from: ANA,
        subject: "Re: Dinner?",
        text: "Hello?",
        messageId: "d2@f",
        inReplyTo: "d1@f",
        references: ["d1@f"],
      },
      IMPORTANT,
    );
    await sync();
    expect(await waiting("you")).toEqual(["Dinner?"]);
    const draft = await ok<{ id: string }>("mail.draft", { threadId: x!.id, text: "Yes!" });
    await ok("mail.send", { id: draft.id });
    expect(await waiting("you")).toEqual([]);
    expect(await waiting("them")).toEqual(["Dinner?"]);
  });
});

describe("what mail can't do to the rules", () => {
  it("ignores ids that aren't conversations", async () => {
    const task = await ok<{ id: string }>("task.create", { title: "Keep me" });
    expect(await ok("mail.no_reply", { ids: [task.id], needed: true })).toEqual({ changed: 0 });
    expect(await ok<{ id: string }>("task.get", { id: task.id })).toMatchObject({ id: task.id });
  });

  it("doesn't take a From line naming you as something you sent", async () => {
    g.gmail.deliver({ from: { address: ME }, to: [ANA], subject: "Spoof", text: "Still there?" });
    await sync();
    expect(await waiting("them")).toEqual([]);
  });

  it("brings back a conversation you set aside when a backdated message arrives", async () => {
    g.gmail.deliver({ from: ANA, subject: "Dinner?", text: "?", messageId: "d1@f" }, IMPORTANT);
    await sync();
    const [x] = await ok<ThreadSummary[]>("mail.threads", { waiting: "you" });
    await ok("mail.no_reply", { ids: [x!.id] });
    g.gmail.deliver({
      from: ANA,
      subject: "Re: Dinner?",
      text: "Hello?",
      messageId: "d0@f",
      references: ["d1@f"],
      inReplyTo: "d1@f",
      date: new Date("2020-01-01T00:00:00Z"),
    });
    await sync();
    expect(await waiting("you")).toHaveLength(1);
  });
});

const DAY_MS = 24 * 3600_000;
const firing = () => ({
  scheduledFor: t.clock.now(),
  event: {} as HearthEvent,
  digest: async () => [],
});
const ctx = () => ({ db: t.tdb.db, now: t.clock.now() });

describe("follow-ups", () => {
  it("drafts follow-ups for unanswered questions after three quiet days, once", async () => {
    seed();
    await sync();
    expect(await followUpRoutine.run(firing(), ctx())).toEqual([]);
    t.clock.advance(4 * DAY_MS);
    const out = await followUpRoutine.run(firing(), ctx());
    expect(out).toMatchObject([{ kind: "turn", untrusted: true }]);
    const digest = await waitingDigest(ctx());
    expect(digest).toEqual([
      { bucket: "today", text: "1 email needs your reply." },
      expect.objectContaining({
        text: "No answer for 4 days from bo@x.example: Contract",
        outside: true,
      }),
    ]);
    expect(await followUpRoutine.run(firing(), ctx())).toEqual([]);
    // The brief still lists it.
    expect(await waitingDigest(ctx())).toHaveLength(2);
  });
});

describe("reply drafts", () => {
  /** The subjects of the conversations a turn's prompt lists, in its order. */
  async function listed(prompt: string) {
    const all = await ok<ThreadSummary[]>("mail.threads", { view: "all", limit: 100 });
    const subjects = new Map(all.map((x) => [x.id, x.subject]));
    return prompt
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => subjects.get(l.slice(2)));
  }

  it("drafts the newest replies you owe from the last week, in one untrusted quick turn", async () => {
    // Waiting on you for ten days: dealt with some other way, most likely.
    g.gmail.deliver(
      { from: ANA, subject: "Old", text: "?", date: new Date("2026-09-21T12:00:00Z") },
      IMPORTANT,
    );
    for (let n = 1; n <= 10; n++)
      g.gmail.deliver({ from: ANA, subject: `Q${n}`, text: "?" }, IMPORTANT);
    // Newer, but not waiting on you: a stranger Gmail doesn't flag, and mail you're waiting on.
    g.gmail.deliver({ from: { address: "cy@else.example" }, subject: "Stranger", text: "?" });
    g.gmail.deliver(
      { from: { address: ME }, to: [ANA], subject: "Contract", text: "Did you sign it?" },
      ["SENT"],
    );
    await sync();
    const q10 = (await ok<ThreadSummary[]>("mail.threads", { waiting: "you" })).find(
      (x) => x.subject === "Q10",
    );
    await ok("mail.draft", { threadId: q10!.id, text: "Already on it" });

    const out = await replyDraftRoutine.run(firing(), ctx());
    expect(out).toMatchObject([
      {
        kind: "turn",
        trigger: "routine",
        lane: "fast",
        untrusted: true,
        dedupeKey: "reply_drafts:2026-10-01",
        context: { routine: "reply_drafts", threads: REPLY_DRAFTS },
      },
    ]);
    const prompt = (out[0] as { prompt: string }).prompt;
    expect(await listed(prompt)).toEqual(["Q9", "Q8", "Q7", "Q6", "Q5", "Q4", "Q3", "Q2"]);
    expect(prompt).toContain("never set to, cc or bcc");
    expect(prompt).toContain("never call mail_send or mail_no_reply");
  });

  it("does nothing while Jarvis is paused, and leaves follow-ups to draft once it's back", async () => {
    seed();
    await sync();
    t.clock.advance(4 * DAY_MS);
    await setSetting(t.tdb.db, "jarvis.paused", true);
    expect(await replyDraftRoutine.run(firing(), ctx())).toEqual([]);
    expect(await followUpRoutine.run(firing(), ctx())).toEqual([]);
    const nudged = await t.tdb.db.select({ at: mailThread.nudgedAt }).from(mailThread);
    expect(nudged.map((r) => r.at)).toEqual(nudged.map(() => null));

    await setSetting(t.tdb.db, "jarvis.paused", false);
    expect(await replyDraftRoutine.run(firing(), ctx())).toHaveLength(1);
    expect(await followUpRoutine.run(firing(), ctx())).toHaveLength(1);
  });

  it("tells the brief how many replies Jarvis drafted, until you send them", async () => {
    seed();
    await sync();
    const [dinner] = await ok<ThreadSummary[]>("mail.threads", { waiting: "you" });
    const draft = await ok<{ id: string }>(
      "mail.draft",
      { threadId: dinner!.id, text: "Friday works." },
      jarvisCaller("untrusted"),
    );
    // Your own drafts aren't Jarvis's to count.
    const [contract] = await ok<ThreadSummary[]>("mail.threads", { view: "all", waiting: "them" });
    await ok("mail.draft", { threadId: contract!.id, text: "Any news?" });
    expect(await waitingDigest(ctx())).toEqual([
      { bucket: "today", text: "1 email needs your reply." },
      { bucket: "prepared", text: "1 reply drafted, waiting in Mail for you to send." },
    ]);
    await ok("mail.send", { id: draft.id });
    expect(await waitingDigest(ctx())).toEqual([]);
  });
});
