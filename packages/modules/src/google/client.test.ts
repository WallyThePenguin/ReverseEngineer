import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { googleAccount, googleQuota } from "@hearth/db";
import { integrationCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_MODULES } from "../index.ts";
import { BLOB_SERVICE, BlobStore } from "../mail/blobs.ts";
import { GOOGLE_SERVICE, GoogleApiError, GoogleClient, SCOPES } from "./client.ts";
import { retryAfter } from "./errors.ts";
import { FakeGoogle } from "./fake.ts";

const ME = "owner@example.com";
const CALENDARS = "https://www.googleapis.com/calendar/v3/users/me/calendarList";

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
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.calendar, ...SCOPES.gmail]));
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

const PROFILE = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const tokenCalls = () => g.calls.filter((c) => c.path === "/token").length;
const status = async () =>
  (await t.tdb.db.select().from(googleAccount).where(eq(googleAccount.email, ME)))[0]?.status;

describe("token refresh, shared through the database", () => {
  it("refreshes an expired token once when two calls need it at the same time", async () => {
    await t.tdb.db
      .update(googleAccount)
      .set({ accessExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(googleAccount.email, ME));
    g.latencyMs = 20;
    const client = g.client(t.tdb.db);
    const before = tokenCalls();
    await within(
      10_000,
      Promise.all([
        t.tdb.db.transaction((tx) => client.call(tx, ME, "GET", PROFILE)),
        t.tdb.db.transaction((tx) => client.call(tx, ME, "GET", PROFILE)),
      ]),
    );
    expect(tokenCalls()).toBe(before + 1);
    const [acct] = await t.tdb.db.select().from(googleAccount);
    expect(acct!.accessExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("tries once more with a fresh token when Google turns one down", async () => {
    const client = g.client(t.tdb.db);
    await client.call(t.tdb.db, ME, "GET", PROFILE);
    g.invalidateTokens();
    const before = tokenCalls();
    await expect(client.call(t.tdb.db, ME, "GET", PROFILE)).resolves.toMatchObject({
      emailAddress: ME,
    });
    expect(tokenCalls()).toBe(before + 1);
    expect(await status()).toBe("ok");
  });

  it("asks you to reconnect when Google won't refresh access", async () => {
    const client = g.client(t.tdb.db);
    g.revoked = true;
    await expect(client.call(t.tdb.db, ME, "GET", PROFILE)).rejects.toMatchObject({
      kind: "auth",
    });
    expect(await status()).toBe("revoked");
  });
});

describe("calls", () => {
  it("gives up on a call with no answer after the timeout", async () => {
    const client = new GoogleClient({
      clientId: "test-client",
      clientSecret: "test-secret",
      redirectUri: "http://localhost:4400/api/google/callback",
      timeoutMs: 50,
      fetch: (_url, init) =>
        new Promise((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        ),
    });
    await expect(client.call(t.tdb.db, ME, "GET", PROFILE)).rejects.toMatchObject({
      kind: "transient",
      reason: "timeout",
    });
  });

  it("pauses the account for every process when Google says slow down", async () => {
    const client = g.client(t.tdb.db);
    const other = g.client(t.tdb.db);
    g.gmail.failNext(1, 403);
    const err = await client.call(t.tdb.db, ME, "GET", PROFILE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err).toMatchObject({ kind: "rate_limited", retryAfterMs: 60_000, quotaLimit: "250" });
    expect(g.logs.join("\n")).toMatch(
      /gmail for owner@example.com paused until .*quota limit: 250/,
    );
    // The other process doesn't even ask until the pause is over.
    const calls = g.gmail.requests.length;
    await expect(other.call(t.tdb.db, ME, "GET", PROFILE)).rejects.toMatchObject({
      kind: "rate_limited",
    });
    expect(g.gmail.requests.length).toBe(calls);
    const [q] = await t.tdb.db.select().from(googleQuota);
    expect(q).toMatchObject({ account: ME, service: "gmail" });
    // Calendar has a quota of its own, and isn't held up.
    await expect(other.call(t.tdb.db, ME, "GET", CALENDARS)).resolves.toBeTruthy();
  });

  it("holds back a call this minute's budget can't take, without sending it", async () => {
    const client = g.client(t.tdb.db, { allowances: { gmail: { units: 10, headroom: 100 } } });
    await client.call(t.tdb.db, ME, "GET", PROFILE, undefined, { cost: 5 });
    await client.call(t.tdb.db, ME, "GET", PROFILE, undefined, { cost: 5 });
    const calls = g.gmail.requests.length;
    await expect(
      client.call(t.tdb.db, ME, "GET", PROFILE, undefined, { cost: 5 }),
    ).rejects.toMatchObject({ kind: "paced" });
    expect(g.gmail.requests.length).toBe(calls);
    // Sending mail may use the headroom.
    await client.call(t.tdb.db, ME, "GET", PROFILE, undefined, { cost: 100, priority: true });
  });

  it("reads Retry-After as seconds or a date", () => {
    const now = Date.parse("2026-10-04T12:00:00Z");
    expect(retryAfter("120", now)).toBe(120_000);
    expect(retryAfter("Sun, 04 Oct 2026 12:01:30 GMT", now)).toBe(90_000);
    expect(retryAfter(null, now)).toBeNull();
    expect(retryAfter("soon", now)).toBeNull();
  });
});
