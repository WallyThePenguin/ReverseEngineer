// The worker's mail rounds (D55). On 2026-10-04 the server's sync right after connecting Gmail and
// the worker's a few seconds later together ran Gmail past its per-minute limit, and every sync
// after that failed. The first test replays that, with two processes on one database.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mailAccount, mailMessage } from "@hearth/db";
import { integrationCaller, Kernel, Registry } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { ALL_MODULES, BLOB_SERVICE, BlobStore, GOOGLE_SERVICE, SCOPES } from "@hearth/modules";
import { FakeGoogle } from "@hearth/modules/google-testing";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mailRound } from "./mail-loop.ts";

const ME = "owner@example.com";

let t: TestKernel;
let g: FakeGoogle;
let dir: string;
let worker: Kernel;

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(ME);
  g.grants = ["openid", "email", ...SCOPES.gmail];
  g.clock = t.clock;
  // Like the real one that day: calls turned away past about 550 units a minute.
  g.gmail.limit = { units: 550, windowMs: 60_000 };
  dir = await mkdtemp(join(tmpdir(), "hearth-blobs-"));
  const blobs = new BlobStore(dir);
  // The server: t.kernel. The worker: another process with its own Google client.
  t.kernel.services[GOOGLE_SERVICE] = g.client(t.tdb.db);
  t.kernel.services[BLOB_SERVICE] = blobs;
  worker = new Kernel({
    db: t.tdb.db,
    registry: new Registry(ALL_MODULES),
    clock: t.clock,
    log: () => {},
    services: { [GOOGLE_SERVICE]: g.client(t.tdb.db), [BLOB_SERVICE]: blobs },
  });
  const client = g.client(t.tdb.db);
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.gmail]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
});
afterEach(async () => {
  await t.destroy();
  await rm(dir, { recursive: true, force: true });
});

const now = () => t.clock.now().getTime();
const stored = async () => (await t.tdb.db.select().from(mailMessage)).length;

describe("mail rounds", () => {
  it("doesn't run Gmail over its limit when the server's sync and the worker's overlap", async () => {
    // That day's numbers a fifth the size, so it saves 60 messages rather than 300 (its time is
    // all database work): each process may spend 80 units a minute, and Gmail turns calls away
    // past 110. Two that each counted only their own would go over; the two together mustn't.
    g.gmail.limit = { units: 110, windowMs: 60_000 };
    const allowances = { gmail: { units: 80, headroom: 20 } };
    t.kernel.services[GOOGLE_SERVICE] = g.client(t.tdb.db, { allowances });
    worker.services[GOOGLE_SERVICE] = g.client(t.tdb.db, { allowances });
    for (let i = 0; i < 60; i++)
      g.gmail.deliver({
        from: { address: `p${i % 30}@x.example` },
        subject: `Mail ${i}`,
        text: ".",
      });
    // The server's sync right after you connect...
    const kick = await t.kernel.execute("mail.sync", { account: ME }, integrationCaller("google"));
    expect(kick.status).toBe("ok");
    // ...and the worker's round a few seconds later, in the same minute.
    t.clock.advance(5_000);
    const round = await mailRound(worker, { now });
    expect(round.accounts[ME]).toBe("paced");
    expect(g.gmail.rejected).toBe(0);
    // A minute at a time, the rest comes in, and Gmail never turns a call away.
    let minutes = 0;
    while (minutes < 20) {
      t.clock.advance(60_000);
      minutes++;
      if ((await mailRound(worker, { now })).accounts[ME] === "done") break;
    }
    expect(await stored()).toBe(60);
    expect(g.gmail.rejected).toBe(0);
    expect([...g.gmail.gets.values()].every((n) => n === 1)).toBe(true);
    expect(minutes).toBeGreaterThan(2);
  }, 60_000);

  it("stops for the round when Gmail says slow down, without counting a failure", async () => {
    await mailRound(worker, { now });
    g.gmail.deliver({ from: { address: "a@x.example" }, subject: "Hi", text: "." });
    g.gmail.failNext(1, 429);
    const round = await mailRound(worker, { now });
    expect(round).toEqual({ syncs: 1, accounts: { [ME]: "paused" } });
    const [acct] = await t.tdb.db.select().from(mailAccount);
    expect(acct).toMatchObject({ syncState: "paused", failures: 0 });
  });

  it("tries again after a network blip, waiting outside any transaction", async () => {
    await mailRound(worker, { now });
    g.gmail.deliver({ from: { address: "a@x.example" }, subject: "Hi", text: "." });
    g.gmail.failNext(1, 503);
    const waits: number[] = [];
    const round = await mailRound(worker, {
      now,
      sleep: async (ms) => {
        waits.push(ms);
        // Nothing is held while it waits: another process can take the account meanwhile.
        const [row] = (
          await t.tdb.db.execute<{ locked: boolean }>(
            sql`SELECT pg_try_advisory_lock(${0x6d61696c}, hashtext(${`gmail:${ME}`})) AS locked`,
          )
        ).rows;
        expect(row?.locked).toBe(true);
        await t.tdb.db.execute(
          sql`SELECT pg_advisory_unlock(${0x6d61696c}, hashtext(${`gmail:${ME}`}))`,
        );
      },
    });
    expect(waits).toEqual([1_000]);
    expect(round.accounts[ME]).toBe("done");
    expect(await stored()).toBe(1);
    const [acct] = await t.tdb.db.select().from(mailAccount);
    expect(acct).toMatchObject({ syncState: "ok", failures: 0 });
  });

  it("leaves an account another sync is working on", async () => {
    await mailRound(worker, { now });
    let release!: () => void;
    let taken!: () => void;
    const isTaken = new Promise<void>((r) => {
      taken = r;
    });
    const holding = t.tdb.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${0x6d61696c}, hashtext(${`gmail:${ME}`}))`,
      );
      taken();
      await new Promise<void>((r) => {
        release = r;
      });
    });
    await isTaken;
    const round = await mailRound(worker, { now });
    release();
    await holding;
    expect(round).toEqual({ syncs: 1, accounts: { [ME]: "busy" } });
  });

  it("starts no sync once the round's time is up", async () => {
    for (let i = 0; i < 150; i++)
      g.gmail.deliver({ from: { address: "a@x.example" }, subject: `Mail ${i}`, text: "." });
    // Each look at the clock is half a minute later: one sync, then the round is over.
    let clock = 0;
    const round = await mailRound(worker, { budgetMs: 50_000, now: () => (clock += 30_000) });
    expect(round.syncs).toBe(1);
    expect(round.accounts[ME]).toBe("time");
  });
});
