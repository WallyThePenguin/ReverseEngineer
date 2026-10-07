// Mail to any of your addresses is to you (6.9): any spelling of your Gmail address, a +tag, an
// address you send as, or another account you've connected.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integrationCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import { BLOB_SERVICE, BlobStore } from "./blobs.ts";
import { addressKey } from "./mine.ts";
import type { ThreadSummary } from "./views.ts";

const ME = "sam.owner@gmail.com";
const ANA = { address: "ana@friends.example", name: "Ana Silva" };
/** Gmail marks it important, so it needs a reply whoever Ana is. */
const IMPORTANT = ["INBOX", "UNREAD", "CATEGORY_PERSONAL", "IMPORTANT"];

describe("addressKey", () => {
  it("tells your Gmail address apart as Gmail does: no case, dots or +tag", () => {
    expect(addressKey("Sam.Owner@Gmail.com")).toBe("samowner@gmail.com");
    expect(addressKey("s.a.m.owner+hearth@gmail.com")).toBe("samowner@gmail.com");
    expect(addressKey("samowner@googlemail.com")).toBe("samowner@gmail.com");
  });

  it("keeps the dots elsewhere, where they can be someone else", () => {
    expect(addressKey("Sam.Owner+news@Studio.example")).toBe("sam.owner@studio.example");
    expect(addressKey("samowner@studio.example")).not.toBe(addressKey("sam.owner@studio.example"));
    expect(addressKey("+only@studio.example")).toBe("+only@studio.example");
  });
});

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
  await connect();
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
const sync = () => t.kernel.execute("mail.sync", {}, integrationCaller("google"));
const toReply = async () => {
  const res = await t.kernel.execute<ThreadSummary[]>(
    "mail.threads",
    { view: "all", waiting: "you" },
    ownerCaller(),
  );
  if (res.status !== "ok") throw new Error(JSON.stringify(res));
  return res.result.map((x) => x.subject).sort();
};
const fromAna = (to: string, subject: string) =>
  g.gmail.deliver({ from: ANA, to: [{ address: to }], subject, text: "?" }, IMPORTANT);

describe("needs your reply", () => {
  it("counts mail to any spelling of your address, and only yours", async () => {
    fromAna("SamOwner@gmail.com", "Case and dots");
    fromAna("sam.owner+hearth@gmail.com", "A +tag");
    fromAna("sam.owner@googlemail.com", "Googlemail");
    fromAna("samowner@studio.example", "Someone else");
    await sync();
    expect(await toReply()).toEqual(["A +tag", "Case and dots", "Googlemail"]);
  });

  it("counts mail to an address you send as, once you've sent from it", async () => {
    const ALIAS = "sam@studio.example";
    fromAna(ALIAS, "Before");
    await sync();
    expect(await toReply()).toEqual([]);
    // You send as it from Gmail ("Send mail as"): your Sent mail says so.
    g.gmail.deliver(
      { from: { address: ALIAS }, to: [{ address: "bo@x.example" }], subject: "Hi", text: "." },
      ["SENT"],
    );
    fromAna("Sam+site@Studio.example", "After");
    await sync();
    expect(await toReply()).toEqual(["After"]);
  });

  it("counts mail to another account you've connected", async () => {
    const WORK = "sam@work.example";
    g.addAccount(WORK);
    g.signingIn = WORK;
    await connect();
    // Work mail forwarded to your Gmail.
    fromAna(WORK, "Forwarded from work");
    await sync();
    expect(await toReply()).toEqual(["Forwarded from work"]);
  });
});
