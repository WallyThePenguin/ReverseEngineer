// Two Gmail accounts: a draft goes from the one you pick, and disconnecting one takes its mail,
// files and notices with it, keeping its unsent drafts if you say so (6.9).
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calendar, mailMessage, notification } from "@hearth/db";
import { integrationCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_MODULES } from "../index.ts";
import { BLOB_SERVICE, BlobStore } from "../mail/blobs.ts";
import type { DraftView } from "../mail/drafts.ts";
import { sendAction } from "../mail/send.ts";
import type { ThreadSummary } from "../mail/views.ts";
import { GOOGLE_SERVICE, SCOPES } from "./client.ts";
import { FakeGoogle } from "./fake.ts";

const ME = "owner@example.com";
const WORK = "work@example.com";
const ANA = { address: "ana@friends.example", name: "Ana Silva" };

let t: TestKernel;
let g: FakeGoogle;
let dir: string;
let blobs: BlobStore;

async function signIn(email: string) {
  g.signingIn = email;
  const client = g.client(t.tdb.db);
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.calendar, ...SCOPES.gmail]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
}

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(ME);
  g.clock = t.clock;
  g.addAccount(WORK);
  g.grants = ["openid", "email", ...SCOPES.calendar, ...SCOPES.gmail];
  t.kernel.services[GOOGLE_SERVICE] = g.client(t.tdb.db);
  dir = await mkdtemp(join(tmpdir(), "hearth-blobs-"));
  blobs = new BlobStore(dir);
  t.kernel.services[BLOB_SERVICE] = blobs;
  await signIn(ME);
  t.clock.advance(60_000);
  await signIn(WORK);
  g.gmail.deliver({ from: ANA, subject: "Dinner?", text: "Friday?" });
  g.accounts
    .get(WORK)!
    .gmail.deliver({ from: ANA, to: [{ address: WORK }], subject: "Q4", text: "?" });
  for (let i = 0; i < 10; i++) {
    const res = await t.kernel.execute<{ more: boolean }>(
      "mail.sync",
      {},
      integrationCaller("google"),
    );
    if (res.status !== "ok" || !res.result.more) break;
  }
  await t.kernel.execute("calendar.sync", {}, integrationCaller("google"));
  expect(await t.tdb.db.select().from(calendar)).toHaveLength(2);
});
afterEach(async () => {
  await t.destroy();
  await rm(dir, { recursive: true, force: true });
});

async function ok<T>(name: string, input: unknown = {}) {
  const res = await t.kernel.execute<T>(name, input, ownerCaller());
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const threadOf = async (subject: string) =>
  (await ok<ThreadSummary[]>("mail.threads", { view: "all" })).find((x) => x.subject === subject)!;
const drafts = () => ok<DraftView[]>("mail.drafts");
const alert = async (dedupeKey: string) => {
  await t.tdb.db.insert(notification).values({
    id: randomUUID(),
    kind: "system.alert",
    title: "Isn't syncing",
    dedupeKey,
    createdBy: "jarvis",
  });
  return async () =>
    (await t.tdb.db.select().from(notification).where(eq(notification.dedupeKey, dedupeKey)))[0]
      ?.state;
};

describe("which account an email goes from", () => {
  it("is the one you pick", async () => {
    const d = await ok<DraftView>("mail.draft", { to: ["bo@x.example"], text: "Hi" });
    expect(d.account).toBe(ME);
    const changed = await ok<DraftView & { snapshot: { from: string } }>("mail.draft_update", {
      id: d.id,
      account: WORK,
    });
    expect(changed).toMatchObject({ account: WORK, snapshot: { from: WORK } });
    const res = await t.kernel.execute(
      "mail.draft_update",
      { id: d.id, account: "x@y.example" },
      ownerCaller(),
    );
    expect(res).toMatchObject({ status: "error", code: "not_found" });
    await ok("mail.send", { id: d.id });
    expect(g.gmail.sent).toHaveLength(0);
    expect(g.accounts.get(WORK)!.gmail.sent).toHaveLength(1);
  });
});

describe("disconnecting a Google account", () => {
  it("keeps its unsent drafts when you say so, to send from another account", async () => {
    const reply = await ok<DraftView>("mail.draft", {
      threadId: (await threadOf("Q4")).id,
      text: "Yes",
    });
    const fresh = await ok<DraftView>("mail.draft", {
      account: WORK,
      to: ["bo@x.example"],
      text: ".",
    });
    await ok("mail.draft", { to: ["cy@x.example"], text: "Mine" });
    expect(await ok("google.disconnect", { email: WORK, keepDrafts: true })).toEqual({
      removed: 1,
      keptDrafts: 2,
    });
    const left = await drafts();
    expect(left).toHaveLength(3);
    const kept = left.filter((d) => d.account === null).map((d) => d.id);
    expect(kept.sort()).toEqual([reply.id, fresh.id].sort());
    // Its conversation went with the account, so the reply is a draft of its own now.
    expect(left.find((d) => d.id === reply.id)).toMatchObject({ threadId: null, to: [ANA] });
    expect(
      (await ok<ThreadSummary[]>("mail.threads", { view: "all" })).map((x) => x.subject),
    ).toEqual(["Dinner?"]);
    // It goes nowhere until you pick who it's from.
    const res = await t.kernel.execute("mail.send", { id: reply.id }, ownerCaller());
    expect(res).toMatchObject({ status: "error", code: "invalid_input" });
    await expect(
      sendAction.snapshot!({ id: reply.id }, { db: t.tdb.db, now: t.clock.now() }),
    ).rejects.toThrow(/Pick which account/);
    await ok("mail.draft_update", { id: reply.id, account: ME });
    await ok("mail.send", { id: reply.id });
    expect(g.gmail.sent).toHaveLength(1);
  });

  it("takes its drafts, notices and mail files with it by default", async () => {
    await ok("mail.draft", { account: WORK, to: ["bo@x.example"], text: "." });
    const files = async (account: string) =>
      (
        await t.tdb.db
          .select({ hash: mailMessage.rawHash })
          .from(mailMessage)
          .where(eq(mailMessage.accountId, `gmail:${account}`))
      ).map((m) => m.hash);
    const [workFile] = await files(WORK);
    const [myFile] = await files(ME);
    const work = await alert(`mail.sync_failed:gmail:${WORK}:2026-10-01T14:00:00.000Z`);
    const mine = await alert(`mail.sync_failed:gmail:${ME}:2026-10-01T14:00:00.000Z`);
    const cal = await alert("calendar.sync_failed:2026-10-01");
    // Calendar's notice is for the account that's going; mine still syncs fine.
    await t.tdb.db
      .update(calendar)
      .set({ lastError: "Forbidden" })
      .where(eq(calendar.account, WORK));

    expect(await ok("google.disconnect", { email: WORK })).toEqual({ removed: 1, keptDrafts: 0 });
    expect(await drafts()).toEqual([]);
    expect([await work(), await mine(), await cal()]).toEqual(["done", "unseen", "done"]);
    await vi.waitFor(async () => expect(await blobs.has(workFile!)).toBe(false));
    expect(await blobs.has(myFile!)).toBe(true);
  });

  it("leaves Calendar's notice open while another calendar still fails", async () => {
    const cal = await alert("calendar.sync_failed:2026-10-01");
    await t.tdb.db.update(calendar).set({ lastError: "Forbidden" }).where(eq(calendar.account, ME));
    await ok("google.disconnect", { email: WORK });
    expect(await cal()).toBe("unseen");
  });
});
