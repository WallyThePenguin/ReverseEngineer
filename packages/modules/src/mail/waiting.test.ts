import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mailThread } from "@hearth/db";
import { type Caller, type HearthEvent, integrationCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import { BLOB_SERVICE, BlobStore } from "./blobs.ts";
import type { ThreadSummary } from "./views.ts";
import { followUpRoutine, waitingDigest } from "./waiting.ts";

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

describe("follow-ups", () => {
  const firing = () => ({
    scheduledFor: t.clock.now(),
    event: {} as HearthEvent,
    digest: async () => [],
  });

  it("drafts follow-ups for unanswered questions after three quiet days, once", async () => {
    seed();
    await sync();
    const ctx = () => ({ db: t.tdb.db, now: t.clock.now() });
    expect(await followUpRoutine.run(firing(), ctx())).toEqual([]);
    t.clock.advance(4 * 24 * 3600_000);
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
