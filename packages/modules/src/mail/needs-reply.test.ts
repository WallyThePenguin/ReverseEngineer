// "Needs your reply" is for a person writing to you (6.9): someone you know, or mail Gmail marks
// important, and never mail sent to many at once or by a machine, by its headers.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mailMessage, mailThread } from "@hearth/db";
import { integrationCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import { BLOB_SERVICE, BlobStore } from "./blobs.ts";
import type { ThreadSummary } from "./views.ts";

const ME = "owner@example.com";
const ANA = { address: "ana@friends.example", name: "Ana Silva" };
const IMPORTANT = ["INBOX", "UNREAD", "CATEGORY_PERSONAL", "IMPORTANT"];
const DAY_MS = 24 * 3600_000;

let t: TestKernel;
let g: FakeGoogle;
let dir: string;

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  t.clock.set("2026-10-01T13:00:00Z");
  g = new FakeGoogle(ME);
  g.clock = t.clock;
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

async function ok<T>(name: string, input: unknown = {}) {
  const res = await t.kernel.execute<T>(name, input, ownerCaller());
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const sync = () => t.kernel.execute("mail.sync", {}, integrationCaller("google"));
const toReply = async () =>
  (await ok<ThreadSummary[]>("mail.threads", { view: "all", waiting: "you" }))
    .map((x) => x.subject)
    .sort();

/** You write to Ana, so she's someone you know. */
async function knowAna() {
  g.gmail.deliver({ from: { address: ME }, to: [ANA], subject: "Hello", text: "Hi Ana" }, ["SENT"]);
  await sync();
}

describe("needs your reply", () => {
  it("is for someone you know, or mail Gmail marks important", async () => {
    g.gmail.deliver({ from: { address: "cy@else.example" }, subject: "Cold pitch", text: "?" });
    g.gmail.deliver(
      { from: { address: "dee@else.example" }, subject: "Your lease", text: "?" },
      IMPORTANT,
    );
    await knowAna();
    g.gmail.deliver({ from: ANA, subject: "Lunch?", text: "Thursday?" });
    await sync();
    expect(await toReply()).toEqual(["Lunch?", "Your lease"]);
  });

  it("never asks you to answer a list, a newsletter or a machine", async () => {
    await knowAna();
    const from = (subject: string, headers: Record<string, string>) =>
      g.gmail.deliver({ from: ANA, subject, text: ".", headers }, IMPORTANT);
    from("Weekly digest", { "List-Unsubscribe": "<mailto:leave@friends.example>" });
    from("Club news", { "List-Id": "Book club <club.friends.example>" });
    from("To everyone", { Precedence: "bulk" });
    from("Out of office", { "Auto-Submitted": "auto-replied" });
    // "no" means a person sent it.
    from("Back from leave", { "Auto-Submitted": "no" });
    await sync();
    expect(await toReply()).toEqual(["Back from leave"]);
    const bulk = await t.tdb.db.select({ bulk: mailMessage.bulk }).from(mailMessage);
    expect(bulk.filter((m) => m.bulk)).toHaveLength(4);
  });

  it("reads mail from before for its headers in the daily repair pass", async () => {
    await knowAna();
    g.gmail.deliver(
      {
        from: ANA,
        subject: "Weekly digest",
        text: ".",
        headers: { "List-Unsubscribe": "<mailto:leave@friends.example>" },
      },
      IMPORTANT,
    );
    await sync();
    // As 0032 leaves it: not read for its headers yet, and flagged by the old rule.
    const [m] = await t.tdb.db
      .select()
      .from(mailMessage)
      .where(eq(mailMessage.fromAddress, ANA.address));
    await t.tdb.db
      .update(mailMessage)
      .set({ bulk: null })
      .where(eq(mailMessage.entityId, m!.entityId));
    await t.tdb.db
      .update(mailThread)
      .set({ waiting: "you" })
      .where(eq(mailThread.entityId, m!.threadId));
    expect(await toReply()).toEqual(["Weekly digest"]);
    t.clock.advance(DAY_MS + 60_000);
    await sync();
    expect(await toReply()).toEqual([]);
    const [after] = await t.tdb.db
      .select({ bulk: mailMessage.bulk })
      .from(mailMessage)
      .where(eq(mailMessage.entityId, m!.entityId));
    expect(after?.bulk).toBe(true);
  });
});
