// The mail list a page at a time (6.9): each page carries on after the last one shown, by its time
// and then its id, so conversations from the same moment are neither skipped nor shown twice.
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
import type { ThreadSummary } from "./views.ts";

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

describe("the mail list, a page at a time", () => {
  it("shows every conversation once, in order, even ones from the same moment", async () => {
    const same = new Date("2026-10-01T09:00:00Z");
    for (let i = 1; i <= 7; i++)
      g.gmail.deliver({
        from: { address: `p${i}@friends.example` },
        subject: `Note ${i}`,
        text: ".",
        // Five of them at the very same second.
        ...(i <= 5 ? { date: same } : {}),
      });
    await t.kernel.execute("mail.sync", {}, integrationCaller("google"));
    const all = await ok<ThreadSummary[]>("mail.threads", { limit: 50 });
    expect(all).toHaveLength(7);
    const seen: string[] = [];
    let cursor = {};
    for (let round = 0; round < 10; round++) {
      const page = await ok<ThreadSummary[]>("mail.threads", { limit: 2, ...cursor });
      seen.push(...page.map((x) => x.id));
      const end = page.at(-1);
      if (!end) break;
      cursor = { before: new Date(end.lastMessageAt).toISOString(), beforeId: end.id };
    }
    expect(seen).toEqual(all.map((x) => x.id));
  });
});
