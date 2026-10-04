// Mail sync that paces itself (D55): what happens when Gmail says slow down, a big backlog, flag
// changes on mail Hearth doesn't keep, batched archives, and alerts that close again.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mailMessage, notification } from "@hearth/db";
import { type HearthEvent, integrationCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import { BLOB_SERVICE, BlobStore } from "./blobs.ts";
import { mailModule } from "./index.ts";
import type { MailSyncResult } from "./sync.ts";
import type { ThreadSummary } from "./views.ts";

const ME = "owner@example.com";
const ANA = { address: "ana@friends.example", name: "Ana Silva" };

let t: TestKernel;
let g: FakeGoogle;
let dir: string;

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(ME);
  g.grants = ["openid", "email", ...SCOPES.gmail];
  g.clock = t.clock;
  // Like the real one on 2026-10-04: calls turned away past about 550 units a minute.
  g.gmail.limit = { units: 550, windowMs: 60_000 };
  t.kernel.services[GOOGLE_SERVICE] = g.client(t.tdb.db);
  dir = await mkdtemp(join(tmpdir(), "hearth-blobs-"));
  t.kernel.services[BLOB_SERVICE] = new BlobStore(dir);
  const client = g.client(t.tdb.db);
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.gmail]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
});
afterEach(async () => {
  await t.destroy();
  await rm(dir, { recursive: true, force: true });
});

async function ok<T>(name: string, input: unknown = {}, caller = ownerCaller()): Promise<T> {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const sync = () => ok<MailSyncResult>("mail.sync", {}, integrationCaller("google"));
interface AccountView {
  state: string;
  pausedUntil: string | null;
  waiting: number;
  setAside: number;
  lastError: string | null;
}
const account = async () => (await ok<AccountView[]>("mail.accounts"))[0]!;
const stored = async () => (await t.tdb.db.select().from(mailMessage)).length;
const fetchedOnce = () => [...g.gmail.gets.values()].every((n) => n === 1);

describe("when Gmail says slow down", () => {
  it("keeps what it saved, pauses quietly, and later fetches only the rest", async () => {
    await sync();
    const ids = Array.from({ length: 10 }, (_, i) =>
      g.gmail.deliver({ from: ANA, subject: `Note ${i}`, text: "." }),
    );
    // The history read and four fetches go through; the fifth is turned away.
    g.gmail.failNext(1, 429, 5);
    expect(await sync()).toMatchObject({ added: 4, paused: [ME], failed: [] });
    expect(await stored()).toBe(4);
    const paused = await account();
    expect(paused).toMatchObject({ state: "paused", waiting: 6 });
    expect(new Date(paused.pausedUntil!).getTime()).toBe(t.clock.now().getTime() + 60_000);
    // A slowdown isn't a failure: nothing to tell you about.
    expect(await t.events("mail.sync_failed")).toEqual([]);
    expect(g.logs.join("\n")).toContain("quota limit: 250");

    // Until the pause ends, a sync doesn't call Gmail at all.
    const calls = g.gmail.requests.length;
    expect(await sync()).toMatchObject({ added: 0, paused: [ME] });
    expect(g.gmail.requests.length).toBe(calls);

    t.clock.advance(61_000);
    expect(await sync()).toMatchObject({ added: 6, paused: [] });
    // Then it looks for anything newer.
    expect(await sync()).toMatchObject({ added: 0, more: false });
    expect(ids.map((id) => g.gmail.gets.get(id))).toEqual(ids.map(() => 1));
    expect(await account()).toMatchObject({ state: "ok", pausedUntil: null, waiting: 0 });
  });

  it("brings in a 1,000-message backlog over several minutes without going over", async () => {
    await sync();
    for (let i = 0; i < 1000; i++)
      g.gmail.deliver(
        { from: { address: `news${i % 40}@list.example` }, subject: `Issue ${i}`, text: "." },
        ["INBOX", "CATEGORY_UPDATES"],
      );
    let syncs = 0;
    let minutes = 0;
    for (;;) {
      const r = await sync();
      syncs++;
      expect(r.failed).toEqual([]);
      if (r.retryAt) {
        // Hearth's own pacing: the worker tries again next minute.
        expect(await account()).toMatchObject({ state: "catching_up" });
        t.clock.advance(60_000);
        minutes++;
      } else if (!r.more) break;
    }
    expect(await stored()).toBe(1000);
    expect(g.gmail.rejected).toBe(0);
    expect(fetchedOnce()).toBe(true);
    // 1,000 fetches are 5,000 units: well over ten minutes at 400 a minute.
    expect(minutes).toBeGreaterThanOrEqual(12);
    expect(syncs).toBeGreaterThan(20);
    expect(await account()).toMatchObject({ state: "ok", waiting: 0 });
  }, 240_000);
});

describe("what it fetches", () => {
  it("takes flags from history, and ignores flag changes on mail it doesn't keep", async () => {
    const kept = g.gmail.deliver({ from: ANA, subject: "Kept", text: "." });
    await sync();
    const old = [1, 2, 3].map((i) => g.gmail.seed({ from: ANA, subject: `Old ${i}`, text: "." }));
    for (const id of old) g.gmail.label(id, ["STARRED"], []);
    g.gmail.label(kept, ["STARRED"], []);
    const fetches = g.gmail.count("GET /messages/:id");
    expect(await sync()).toMatchObject({ added: 0 });
    expect(g.gmail.count("GET /messages/:id")).toBe(fetches);
    const [row] = await t.tdb.db.select().from(mailMessage).where(eq(mailMessage.providerId, kept));
    expect(row?.labels).toContain("STARRED");

    // Mail moved back to the inbox is brought in, though.
    g.gmail.label(old[0]!, ["INBOX"], []);
    expect(await sync()).toMatchObject({ added: 1 });
    expect(g.gmail.gets.get(old[0]!)).toBe(1);
    expect(old.slice(1).map((id) => g.gmail.gets.get(id))).toEqual([undefined, undefined]);
  });

  it("sends fifty archives as one change to Gmail", async () => {
    for (let i = 0; i < 50; i++) g.gmail.deliver({ from: ANA, subject: `Thread ${i}`, text: "." });
    await sync();
    const threads = await ok<ThreadSummary[]>("mail.threads", { view: "all" });
    expect(threads).toHaveLength(50);
    for (const x of threads) await ok("mail.archive", { ids: [x.id] });
    expect(await sync()).toMatchObject({ failed: [], paused: [] });
    expect(g.gmail.count("POST /messages/batchModify")).toBe(1);
    expect([...g.gmail.messages.values()].some((m) => m.labelIds.includes("INBOX"))).toBe(false);
  });

  it("puts back only the change Gmail refuses when a batch is turned down", async () => {
    const ids = [1, 2, 3].map((i) => g.gmail.deliver({ from: ANA, subject: `T${i}`, text: "." }));
    await sync();
    for (const x of await ok<ThreadSummary[]>("mail.threads", { view: "all" }))
      await ok("mail.archive", { ids: [x.id] });
    g.gmail.refuseIds.add(ids[1]!);
    await sync();
    // One batch, then one at a time to find the change Gmail won't take.
    expect(g.gmail.count("POST /messages/batchModify")).toBe(4);
    expect(ids.map((id) => g.gmail.messages.get(id)!.labelIds.includes("INBOX"))).toEqual([
      false,
      true,
      false,
    ]);
    expect((await ok<ThreadSummary[]>("mail.threads")).map((x) => x.subject)).toEqual(["T2"]);
    expect(await t.events("mail.change_failed")).toHaveLength(1);
  });
});

describe("alerts", () => {
  /** A sync that fails because Gmail's servers are having trouble, then fifteen minutes pass. */
  const outage = async () => {
    g.gmail.failNext(1, 503);
    const r = await sync();
    expect(r).toMatchObject({ transient: true });
    expect(r.failed).toHaveLength(1);
    t.clock.advance(15 * 60_000);
  };
  const notice = async (e: HearthEvent) => {
    const reflex = mailModule.reflexes!.find((r) => r.name === "mail.sync_failed")!;
    const [out] = await reflex.run(e, { db: t.tdb.db, now: t.clock.now() });
    const key = (out as { notification: { dedupeKey: string } }).notification.dedupeKey;
    // Written as Jarvis writes it.
    await t.tdb.db.insert(notification).values({
      id: randomUUID(),
      kind: "system.alert",
      title: "Mail isn't syncing",
      dedupeKey: key,
      createdBy: "jarvis",
    });
    return key;
  };
  const stateOf = async (key: string) =>
    (await t.tdb.db.select().from(notification).where(eq(notification.dedupeKey, key)))[0]?.state;

  it("waits for a run of failures, then closes the notice once mail syncs again", async () => {
    await sync();
    await outage();
    await outage();
    // Two failures in half an hour are left alone.
    expect(await t.events("mail.sync_failed")).toEqual([]);
    expect(await account()).toMatchObject({ state: "ok" });
    await outage();
    const [first] = await t.events("mail.sync_failed");
    expect(first?.payload).toMatchObject({ account: ME, reconnect: false });
    expect(await account()).toMatchObject({ state: "failing" });
    const key = await notice(first!);

    expect(await sync()).toMatchObject({ failed: [] });
    expect(await stateOf(key)).toBe("done");
    expect(await account()).toMatchObject({ state: "ok", lastError: null });

    // A second outage the same day gets a notice of its own.
    await outage();
    await outage();
    await outage();
    const second = (await t.events("mail.sync_failed"))[1];
    expect(second).toBeDefined();
    const again = await notice(second!);
    expect(again).not.toBe(key);
    expect(await stateOf(again)).toBe("unseen");
  });

  it("alerts at once when Google signs Hearth out, and keeps your changes queued", async () => {
    g.gmail.deliver({ from: ANA, subject: "Plans", text: "?" });
    await sync();
    const [x] = await ok<ThreadSummary[]>("mail.threads");
    await ok("mail.archive", { ids: [x!.id] });
    g.revoked = true;
    expect((await sync()).failed).toHaveLength(1);
    const [e] = await t.events("mail.sync_failed");
    expect(e?.payload).toMatchObject({ reconnect: true });
    expect(await account()).toMatchObject({ state: "failing" });
    expect(await ok("mail.accounts")).toMatchObject([{ pendingChanges: 1 }]);
  });
});
