// Mail sync that can't be stalled (6.2, D55): two syncs at once, and messages that won't save.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mailMessage, mailQuarantine } from "@hearth/db";
import { integrationCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import { BLOB_SERVICE, BlobStore } from "./blobs.ts";
import type { MailSyncResult } from "./sync.ts";
import type { ThreadSummary } from "./views.ts";

const ME = "owner@example.com";
const ANA = { address: "ana@friends.example", name: "Ana Silva" };

/** A blob store that fails for one message, like a disk error on just that write. */
class FlakyBlobs extends BlobStore {
  bad = "";
  override put(data: Buffer): Promise<string> {
    if (this.bad && data.toString("utf8").includes(this.bad))
      return Promise.reject(new Error("disk said no"));
    return super.put(data);
  }
}

let t: TestKernel;
let g: FakeGoogle;
let dir: string;
let blobs: FlakyBlobs;

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(ME);
  g.grants = ["openid", "email", ...SCOPES.gmail];
  g.clock = t.clock;
  t.kernel.services[GOOGLE_SERVICE] = g.client(t.tdb.db);
  dir = await mkdtemp(join(tmpdir(), "hearth-blobs-"));
  blobs = new FlakyBlobs(dir);
  t.kernel.services[BLOB_SERVICE] = blobs;
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
const subjects = async () =>
  (await ok<ThreadSummary[]>("mail.threads", { view: "all" })).map((x) => x.subject).sort();
const account = async () =>
  (await ok<{ waiting: number; setAside: number; state: string }[]>("mail.accounts"))[0]!;

describe("sync safety", () => {
  it("runs one sync at a time per account; the other skips", async () => {
    await sync();
    for (let i = 0; i < 3; i++) g.gmail.deliver({ from: ANA, subject: `Hi ${i}`, text: "." });
    g.latencyMs = 25;
    const [a, b] = await Promise.all([sync(), sync()]);
    expect([a.skipped, b.skipped].filter((s) => s.length > 0)).toEqual([[ME]]);
    expect(a.added + b.added).toBe(3);
    expect(await t.tdb.db.select().from(mailMessage)).toHaveLength(3);
    expect([...g.gmail.gets.values()].every((n) => n === 1)).toBe(true);
  });

  it("brings in mail with NUL bytes and broken characters", async () => {
    await sync();
    g.gmail.deliver({ from: ANA, subject: "Null\u0000byte", text: "Body \u0000 here \uD800 too" });
    g.gmail.deliver({ from: ANA, subject: "After", text: "." });
    expect(await sync()).toMatchObject({ added: 2, failed: [] });
    expect(await subjects()).toEqual(["After", "Nullbyte"]);
  });

  it("skips a message the database won't take, then sets it aside after three tries", async () => {
    await sync();
    g.gmail.deliver({ from: ANA, subject: "Before", text: "." });
    // A Message-ID too long for its index: Postgres refuses the row. Before, that failed the
    // whole sync every minute; now only this message is undone.
    const huge = g.gmail.deliver({
      from: ANA,
      subject: "Huge",
      text: ".",
      messageId: `${randomBytes(6000).toString("base64url")}@x.example`,
    });
    g.gmail.deliver({ from: ANA, subject: "After", text: "." });
    const first = await sync();
    expect(first).toMatchObject({ added: 2, failed: [], more: true });
    expect(await subjects()).toEqual(["After", "Before"]);
    await sync();
    expect(await sync()).toMatchObject({ added: 0, failed: [] });
    expect(await sync()).toMatchObject({ more: false });
    expect(g.gmail.gets.get(huge)).toBe(3);
    expect(await account()).toMatchObject({ setAside: 1, waiting: 0, state: "ok" });
    const [q] = await t.tdb.db.select().from(mailQuarantine);
    expect(q).toMatchObject({ providerId: huge, attempts: 3 });

    // Set aside for good: changes to it later don't bring it back.
    g.gmail.label(huge, ["STARRED"], []);
    g.gmail.label(huge, ["INBOX"], []);
    await sync();
    expect(g.gmail.gets.get(huge)).toBe(3);
  });

  it("lets the rest through when Gmail won't hand one message over, then sets it aside", async () => {
    await sync();
    const bad = g.gmail.deliver({ from: ANA, subject: "Bad", text: "." });
    g.gmail.deliver({ from: ANA, subject: "Good", text: "." });
    g.gmail.brokenIds.set(bad, 400);
    // Before, this one message stopped every sync after it, and alerted at once.
    expect(await sync()).toMatchObject({ added: 1, failed: [], more: true });
    expect(await subjects()).toEqual(["Good"]);
    await sync();
    await sync();
    expect(g.gmail.gets.get(bad)).toBe(3);
    expect(await sync()).toMatchObject({ failed: [], more: false });
    expect(g.gmail.gets.get(bad)).toBe(3);
    expect(await account()).toMatchObject({ setAside: 1, waiting: 0, state: "ok" });
    expect(await t.events("mail.sync_failed")).toEqual([]);
  });

  it("stops, and sets no mail aside, when Gmail turns the whole account away", async () => {
    await sync();
    g.gmail.deliver({ from: ANA, subject: "One", text: "." });
    g.gmail.deliver({ from: ANA, subject: "Two", text: "." });
    // Gmail asks for a pause right after listing them, so the next syncs start on that list.
    g.gmail.failNext(1, 429, 1);
    expect(await sync()).toMatchObject({ added: 0, paused: [ME] });
    t.clock.advance(5 * 60_000);
    // Then Gmail is turned off for the account: every call is refused, not just one message.
    g.gmail.failNext(6, 400);
    for (let i = 0; i < 3; i++)
      expect(await sync()).toMatchObject({
        added: 0,
        failed: [expect.stringContaining("Mail service not enabled")],
      });
    expect(await t.tdb.db.select().from(mailQuarantine)).toEqual([]);
    expect(await account()).toMatchObject({ setAside: 0, waiting: 2, state: "failing" });
    expect(await t.events("mail.sync_failed")).toHaveLength(1);
    // Once it's back on, nothing was lost.
    expect(await sync()).toMatchObject({ added: 2, failed: [] });
    expect(await subjects()).toEqual(["One", "Two"]);
    expect(await sync()).toMatchObject({ failed: [], more: false });
    expect(await account()).toMatchObject({ setAside: 0, waiting: 0, state: "ok" });
  });

  it("lets the rest through when one message never arrives in time, then sets it aside", async () => {
    t.kernel.services[GOOGLE_SERVICE] = g.client(t.tdb.db, { timeoutMs: 50 });
    await sync();
    const huge = g.gmail.deliver({ from: ANA, subject: "Huge", text: "." });
    g.gmail.deliver({ from: ANA, subject: "Next", text: "." });
    g.gmail.hangIds.add(huge);
    // A timeout may be the line, so the sync stops there; the message waits ten minutes aside.
    expect(await sync()).toMatchObject({ added: 0, transient: true });
    expect(await sync()).toMatchObject({ added: 1, transient: false });
    expect(await subjects()).toEqual(["Next"]);
    expect(g.gmail.hung).toBe(1);
    // Timeouts close together count once: a few bad minutes don't set a message aside.
    const attempts = async () => (await t.tdb.db.select().from(mailQuarantine))[0]?.attempts;
    expect(await attempts()).toBe(1);
    t.clock.advance(10 * 60_000);
    await sync();
    t.clock.advance(10 * 60_000);
    await sync();
    expect(await attempts()).toBe(3);
    expect(g.gmail.hung).toBe(3);
    expect(await sync()).toMatchObject({ failed: [], more: false });
    expect(g.gmail.hung).toBe(3);
    expect(await account()).toMatchObject({ setAside: 1, waiting: 0, state: "ok" });
    expect(await t.events("mail.sync_failed")).toEqual([]);
  });

  it("keeps new mail coming while Gmail fails on one message, and sets it aside later", async () => {
    await sync();
    const bad = g.gmail.deliver({ from: ANA, subject: "Bad", text: "." });
    g.gmail.deliver({ from: ANA, subject: "First", text: "." });
    g.gmail.brokenIds.set(bad, 500);
    // Before, it went back in the queue, and Gmail's list of changes is read only once the queue
    // is empty: no new mail came in for as long as Gmail kept failing on it.
    expect(await sync()).toMatchObject({ added: 1, failed: [], transient: false, more: false });
    g.gmail.deliver({ from: ANA, subject: "Second", text: "." });
    expect(await sync()).toMatchObject({ added: 1, failed: [] });
    expect(await subjects()).toEqual(["First", "Second"]);
    expect(g.gmail.gets.get(bad)).toBe(1);
    expect(await account()).toMatchObject({ waiting: 1, setAside: 0, state: "ok" });
    // It's tried again every ten minutes, after any new mail, and set aside on the third failure.
    t.clock.advance(10 * 60_000);
    expect(await sync()).toMatchObject({ added: 0, failed: [] });
    t.clock.advance(10 * 60_000);
    g.gmail.deliver({ from: ANA, subject: "Third", text: "." });
    expect(await sync()).toMatchObject({ added: 1, failed: [], more: false });
    expect(g.gmail.gets.get(bad)).toBe(3);
    t.clock.advance(10 * 60_000);
    await sync();
    expect(g.gmail.gets.get(bad)).toBe(3);
    expect(await account()).toMatchObject({ waiting: 0, setAside: 1, state: "ok" });
    expect(await t.events("mail.sync_failed")).toEqual([]);
  });

  it("brings in a message Gmail failed on once it downloads, as new mail", async () => {
    await sync();
    const late = g.gmail.deliver({ from: ANA, subject: "Late", text: "." });
    g.gmail.brokenIds.set(late, 503);
    expect(await sync()).toMatchObject({ added: 0, failed: [], more: false });
    g.gmail.brokenIds.delete(late);
    expect(await sync()).toMatchObject({ added: 0 });
    t.clock.advance(10 * 60_000);
    expect(await sync()).toMatchObject({ added: 1, failed: [], more: false });
    expect(await account()).toMatchObject({ waiting: 0, setAside: 0 });
    const received = await t.events("mail.received");
    expect(received.map((e) => (e.payload as { subject: string }).subject)).toEqual(["Late"]);
  });

  it("carries on when saving one message fails outside the database", async () => {
    await sync();
    blobs.bad = "Unlucky";
    g.gmail.deliver({ from: ANA, subject: "Unlucky", text: "." });
    g.gmail.deliver({ from: ANA, subject: "Fine", text: "." });
    expect(await sync()).toMatchObject({ added: 1, failed: [] });
    // Once the disk recovers, the next try saves it.
    blobs.bad = "";
    expect(await sync()).toMatchObject({ added: 1, failed: [] });
    expect(await subjects()).toEqual(["Fine", "Unlucky"]);
    expect(await account()).toMatchObject({ setAside: 0, waiting: 0 });
  });
});
