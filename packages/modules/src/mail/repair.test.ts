// Originals missing from this PC come back from Gmail (6.6): in the background, a few a round
// once a day, after which files nothing needs are deleted.
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mailAccount, mailMessage } from "@hearth/db";
import { integrationCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { asc } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import { BLOB_SERVICE, BlobStore } from "./blobs.ts";
import { REPAIR_FETCH } from "./repair.ts";

const ME = "owner@example.com";
const DAY_MS = 24 * 3600_000;

let t: TestKernel;
let g: FakeGoogle;
let dir: string;
let blobs: BlobStore;

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(ME);
  g.clock = t.clock;
  g.grants = ["openid", "email", ...SCOPES.gmail];
  t.kernel.services[GOOGLE_SERVICE] = g.client();
  dir = await mkdtemp(join(tmpdir(), "hearth-blobs-"));
  blobs = new BlobStore(dir);
  t.kernel.services[BLOB_SERVICE] = blobs;
  const client = g.client();
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.gmail]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
  for (let i = 1; i <= 8; i++)
    g.gmail.deliver({
      from: { address: `p${i}@friends.example` },
      subject: `Hi ${i}`,
      text: `${i}`,
    });
});
afterEach(async () => {
  await t.destroy();
  await rm(dir, { recursive: true, force: true });
});

/** Syncs until there's nothing more to bring in. */
async function sync() {
  for (let i = 0; i < 10; i++) {
    const res = await t.kernel.execute<{ more: boolean }>(
      "mail.sync",
      {},
      integrationCaller("google"),
    );
    if (res.status !== "ok" || !res.result.more) return res;
  }
  throw new Error("Mail never caught up");
}
const hashes = async () => (await t.tdb.db.select().from(mailMessage)).map((m) => m.rawHash);
const present = async () => {
  let n = 0;
  for (const h of await hashes()) if (await blobs.has(h)) n++;
  return n;
};
const fileOf = (hash: string) => join(dir, hash.slice(0, 2), hash.slice(2));

describe("missing originals", () => {
  it("come back a few a round, once a day, and files nothing needs are deleted", async () => {
    await sync();
    // The first quiet round already looked: nothing was missing.
    const [account] = await t.tdb.db.select().from(mailAccount);
    expect(account?.repairedAt).toEqual(t.clock.now());
    expect(await present()).toBe(8);

    // Every original lost; and a file nothing needs, from long ago, and one just written by
    // another process for a message it hasn't saved yet.
    await rm(dir, { recursive: true, force: true });
    const old = "ab".repeat(32);
    const fresh = "cd".repeat(32);
    const longAgo = new Date(Date.now() - 2 * 3600_000);
    for (const h of [old, fresh]) {
      await mkdir(join(dir, h.slice(0, 2)), { recursive: true });
      await writeFile(fileOf(h), "x");
    }
    await utimes(fileOf(old), longAgo, longAgo);
    // And a file you added long ago, now in the trash: its bytes stay, for when it comes back.
    const photo = await blobs.put(Buffer.from("a photo"));
    await utimes(fileOf(photo), longAgo, longAgo);
    const file = { hash: photo, name: "photo.jpg", mime: "image/jpeg", size: 7 };
    const added = await t.kernel.execute<{ id: string }>("file.create", file, ownerCaller());
    if (added.status !== "ok") throw new Error(JSON.stringify(added));
    await t.kernel.execute("entity.trash", { id: added.result.id }, ownerCaller());
    expect(await present()).toBe(0);

    // Not again the same day.
    await sync();
    expect(await present()).toBe(0);

    t.clock.advance(DAY_MS);
    await sync();
    expect(await present()).toBe(REPAIR_FETCH);
    await sync();
    expect(await present()).toBe(8);
    // That pass is done: what nothing needs went, unless it's new.
    expect(await blobs.has(old)).toBe(false);
    expect(await blobs.has(fresh)).toBe(true);
    expect(await blobs.has(photo)).toBe(true);
    const [after] = await t.tdb.db.select().from(mailAccount);
    expect(after?.repairFrom).toBeNull();
    expect(after?.repairedAt).toEqual(t.clock.now());
  });

  it("go on past one Gmail won't give, so the rest still come back", async () => {
    await sync();
    const [first] = await t.tdb.db
      .select()
      .from(mailMessage)
      .orderBy(asc(mailMessage.entityId))
      .limit(1);
    g.gmail.brokenIds.set(first!.providerId, 400);
    await rm(dir, { recursive: true, force: true });
    t.clock.advance(DAY_MS);
    await sync();
    await sync();
    expect(await present()).toBe(7);
    const [account] = await t.tdb.db.select().from(mailAccount);
    expect(account?.repairFrom).toBeNull();
    expect(account?.repairedAt).toEqual(t.clock.now());
  });

  it("leave a message Gmail no longer has as it is", async () => {
    await sync();
    await rm(dir, { recursive: true, force: true });
    g.gmail.messages.clear();
    t.clock.advance(DAY_MS);
    expect(await sync()).toMatchObject({ status: "ok", result: { failed: [] } });
    expect(await present()).toBe(0);
    expect(await t.tdb.db.select().from(mailMessage)).toHaveLength(8);
  });
});
