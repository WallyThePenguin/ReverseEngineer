// A send goes out once (D61): when Gmail sent it but Hearth didn't hear back, pressing Send again
// finds it in Sent instead of sending a second copy. A reply goes into its conversation in your
// Gmail too, and a send Gmail won't take for hours says until when.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatTime } from "@hearth/core";
import { mailDraft } from "@hearth/db";
import { type Caller, getSetting, integrationCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import { BLOB_SERVICE, BlobStore } from "./blobs.ts";
import type { DraftView } from "./drafts.ts";
import { parseMail } from "./mime.ts";
import type { ThreadSummary, ThreadView } from "./views.ts";

const ME = "owner@example.com";

let t: TestKernel;
let g: FakeGoogle;
let dir: string;

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(ME);
  g.clock = t.clock;
  g.grants = ["openid", "email", ...SCOPES.gmail];
  t.kernel.services[GOOGLE_SERVICE] = g.client();
  dir = await mkdtemp(join(tmpdir(), "hearth-blobs-"));
  t.kernel.services[BLOB_SERVICE] = new BlobStore(dir);
  const client = g.client();
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.gmail]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
  await run("mail.sync", {}, integrationCaller("google"));
});
afterEach(async () => {
  await t.destroy();
  await rm(dir, { recursive: true, force: true });
});

const run = (name: string, input: unknown = {}, caller: Caller = ownerCaller()) =>
  t.kernel.execute(name, input, caller);
async function ok<T>(name: string, input: unknown = {}): Promise<T> {
  const res = await run(name, input);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result as T;
}
const draft = () =>
  ok<DraftView>("mail.draft", {
    to: ["ana@friends.example"],
    subject: "Plans",
    text: "See you at 6.",
  });

describe("sending once", () => {
  it("chooses the Message-ID when the draft is written, and sends with it", async () => {
    const d = await draft();
    const [row] = await t.tdb.db.select().from(mailDraft).where(eq(mailDraft.entityId, d.id));
    expect(row?.messageId).toMatch(/^[0-9a-f]+@example\.com$/);
    await ok("mail.send", { id: d.id });
    const sent = await parseMail(g.gmail.sent[0]!);
    expect(sent.messageId).toBe(row?.messageId);
  });

  it("doesn't send twice when Gmail sent it but didn't answer", async () => {
    const d = await draft();
    t.clock.advance(60_000);
    g.gmail.loseSendReplies = 1;
    const first = await run("mail.send", { id: d.id });
    expect(first).toMatchObject({ status: "error", code: "unavailable" });
    expect(JSON.stringify(first)).toContain("won't go twice");
    // It went out, and the draft is still here.
    expect(g.gmail.sent).toHaveLength(1);
    expect(await ok<DraftView[]>("mail.drafts")).toHaveLength(1);

    const again = await ok<{ sent: boolean; alreadySent?: boolean; threadId: string }>(
      "mail.send",
      { id: d.id },
    );
    expect(again).toMatchObject({ sent: true, alreadySent: true });
    expect(g.gmail.sent).toHaveLength(1);
    expect(await ok<DraftView[]>("mail.drafts")).toEqual([]);
    // What went out is in the conversation, as Gmail has it.
    const thread = await ok<ThreadView>("mail.thread", { id: again.threadId });
    expect(thread.messages).toMatchObject([{ text: "See you at 6.", outbound: true }]);
  });

  it("finds it by Hearth's own header when Gmail gave it a Message-ID of its own", async () => {
    const d = await draft();
    t.clock.advance(60_000);
    g.gmail.rewriteMessageIds = true;
    g.gmail.loseSendReplies = 1;
    await run("mail.send", { id: d.id });
    expect(await ok("mail.send", { id: d.id })).toMatchObject({ alreadySent: true });
    expect(g.gmail.sent).toHaveLength(1);
  });

  it("finds it by that header even after the draft was changed since", async () => {
    const d = await draft();
    g.gmail.rewriteMessageIds = true;
    g.gmail.loseSendReplies = 1;
    expect(await run("mail.send", { id: d.id })).toMatchObject({ code: "unavailable" });
    // A few minutes on, a change before pressing Send again: it went out already all the same.
    t.clock.advance(3 * 60_000);
    await ok("mail.draft_update", { id: d.id, text: "See you at 7." });
    expect(await run("mail.send", { id: d.id })).toMatchObject({
      status: "ok",
      result: { alreadySent: true },
    });
    expect(g.gmail.sent).toHaveLength(1);
  });

  it("still sends a draft whose earlier Send never left", async () => {
    const d = await draft();
    g.gmail.failNext(1, 503);
    expect(await run("mail.send", { id: d.id })).toMatchObject({ status: "error" });
    expect(g.gmail.sent).toHaveLength(0);
    expect(await ok("mail.send", { id: d.id })).not.toHaveProperty("alreadySent");
    expect(g.gmail.sent).toHaveLength(1);
  });

  it("says when Gmail will take it again, in your time, when it's shut out for hours", async () => {
    const d = await draft();
    const until = new Date(t.clock.now().getTime() + 2 * 3600_000);
    g.gmail.shutOut(until);
    const res = await run("mail.send", { id: d.id });
    expect(res).toMatchObject({ status: "error", code: "unavailable" });
    const { timeZone } = await getSetting(t.tdb.db, "owner.dayRules");
    expect(res).toMatchObject({
      message: `Gmail asked Hearth to slow down, so nothing was sent. Try again after ${formatTime(until, timeZone)}`,
    });
    expect(g.gmail.sent).toEqual([]);
  });

  it("waits for Gmail's sending limit only to send, and says the day when it's tomorrow", async () => {
    const d = await draft();
    // Gmail on the phone counts toward the same limit: sending is shut out until 6 a.m.
    const until = new Date(t.clock.now().getTime() + 20 * 3600_000);
    g.gmail.sendingLimitUntil = until;
    const { timeZone } = await getSetting(t.tdb.db, "owner.dayRules");
    expect(await run("mail.send", { id: d.id })).toMatchObject({
      status: "error",
      message: `Gmail asked Hearth to slow down, so nothing was sent. Try again after ${formatTime(until, timeZone)} tomorrow.`,
    });
    // An hour later the rest of Gmail goes on: mail syncs.
    t.clock.advance(3600_000);
    const calls = g.gmail.requests.length;
    expect(await run("mail.sync", {}, integrationCaller("google"))).toMatchObject({ status: "ok" });
    expect(g.gmail.requests.length).toBeGreaterThan(calls);
    // Sending still waits for Gmail's time, without trying Gmail again.
    expect(await run("mail.send", { id: d.id })).toMatchObject({
      message: expect.stringContaining("tomorrow."),
    });
    expect(g.gmail.count("POST /messages/send")).toBe(1);
    expect(g.gmail.sent).toEqual([]);
  });
});

describe("a reply", () => {
  /** Ana's email, synced, and a reply to it written in Hearth. */
  async function reply() {
    const original = g.gmail.deliver({
      from: { address: "ana@friends.example" },
      subject: "Dinner?",
      text: "Friday at 7?",
    });
    await run("mail.sync", {}, integrationCaller("google"));
    const [thread] = await ok<ThreadSummary[]>("mail.threads");
    const d = await ok<DraftView>("mail.draft", { threadId: thread!.id, text: "Friday works." });
    return { original, d };
  }
  const sentThread = () =>
    [...g.gmail.messages.values()].find((m) => m.labelIds.includes("SENT"))?.threadId;

  it("goes into the conversation in your Gmail, not one of its own", async () => {
    const { original, d } = await reply();
    await ok("mail.send", { id: d.id });
    expect(sentThread()).toBe(original);
  });

  it("still goes, as before, when Gmail can't say which conversation it's in", async () => {
    const { original, d } = await reply();
    g.gmail.brokenIds.set(original, 500);
    await ok("mail.send", { id: d.id });
    expect(g.gmail.sent).toHaveLength(1);
    expect(sentThread()).not.toBe(original);
  });
});
