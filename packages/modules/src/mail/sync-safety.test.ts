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
