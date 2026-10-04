import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { googleAccount } from "@hearth/db";
import { integrationCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_MODULES } from "../index.ts";
import { BLOB_SERVICE, BlobStore } from "../mail/blobs.ts";
import { GOOGLE_SERVICE, SCOPES } from "./client.ts";
import { FakeGoogle } from "./fake.ts";

const ME = "owner@example.com";

let t: TestKernel;
let g: FakeGoogle;
let dir: string;

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(ME);
  g.grants = ["openid", "email", ...SCOPES.calendar, ...SCOPES.gmail];
  dir = await mkdtemp(join(tmpdir(), "hearth-blobs-"));
  t.kernel.services[BLOB_SERVICE] = new BlobStore(dir);
  const client = g.client();
  const url = new URL(
    await client.startSignIn(t.tdb.db, [...SCOPES.calendar, ...SCOPES.gmail]),
  );
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
});
afterEach(async () => {
  await t.destroy();
  await rm(dir, { recursive: true, force: true });
});

const within = <T>(ms: number, p: Promise<T>) =>
  Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`hung for ${ms} ms`)), ms)),
  ]);

describe("token refresh", () => {
  it("doesn't deadlock two syncs that both find the token expired", async () => {
    // The 6.1 deadlock: calendar and mail sync ran at once with an expired token. One refreshed
    // inside its transaction and held the account row; the other waited for that row while the
    // first waited behind it for its next token. Both hung until the process restarted.
    for (let i = 0; i < 4; i++)
      g.gmail.deliver({ from: { address: `a${i}@x.example` }, subject: `s${i}`, text: "." });
    g.put(ME, {
      summary: "Standup",
      start: { dateTime: "2026-10-02T14:00:00Z" },
      end: { dateTime: "2026-10-02T14:30:00Z" },
    });
    g.latencyMs = 20;
    t.kernel.services[GOOGLE_SERVICE] = g.client();
    await t.tdb.db
      .update(googleAccount)
      .set({ accessExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(googleAccount.email, ME));
    const [cal, mail] = await within(
      10_000,
      Promise.all([
        t.kernel.execute("calendar.sync", {}, integrationCaller("google")),
        t.kernel.execute("mail.sync", {}, integrationCaller("google")),
      ]),
    );
    expect(cal.status).toBe("ok");
    expect(mail.status).toBe("ok");
  });
});
