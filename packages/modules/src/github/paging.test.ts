// GitHub read in page by page, its pull requests' changes as events, and what happens when its
// token stops working, is about to, or GitHub keeps failing (6.8, D61).
import { randomBytes, randomUUID } from "node:crypto";
import { githubRepo, notification } from "@hearth/db";
import { type Caller, type HearthEvent, integrationCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VAULT_SERVICE, Vault } from "../browser/vault.ts";
import { ALL_MODULES } from "../index.ts";
import { FakeGithub, GITHUB_SERVICE, GithubError, type PullRequest } from "./api.ts";
import { githubModule } from "./index.ts";

let t: TestKernel;
let g: FakeGithub;
const REPO = "wally/hearth";

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGithub();
  g.repos.set(REPO, []);
  t.kernel.services[GITHUB_SERVICE] = g.api();
  t.kernel.services[VAULT_SERVICE] = new Vault(randomBytes(32));
});
afterEach(() => t.destroy());

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const sync = () =>
  ok<{ prs: number; moved: number; failed: string[] }>(
    "github.sync",
    {},
    integrationCaller("github"),
  );
const connect = () => ok("github.connect", { token: g.token, repos: [REPO] });
const status = () =>
  ok<{ state: string; lastError: string | null; tokenExpiresAt: string | null }>("github.status");
const prCount = async () => (await ok<unknown[]>("github.prs", { limit: 100 })).length;
function pr(number: number, p: Partial<PullRequest> = {}) {
  const made: PullRequest = {
    number,
    title: `Change ${number}`,
    body: "",
    url: `https://github.com/${REPO}/pull/${number}`,
    author: "wally",
    headRef: `b${number}`,
    state: "open",
    updatedAt: new Date(t.clock.now().getTime() + number),
    ...p,
  };
  const list = g.repos.get(REPO)!.filter((x) => x.number !== number);
  g.repos.set(REPO, [...list, made]);
}

async function notice(e: HearthEvent, name = "github.sync_failed") {
  const reflex = githubModule.reflexes.find((r) => r.name === name)!;
  const [out] = await reflex.run(e, { db: t.tdb.db, now: t.clock.now() });
  const key = (out as { notification: { dedupeKey: string } }).notification.dedupeKey;
  await t.tdb.db.insert(notification).values({
    id: randomUUID(),
    kind: "system.alert",
    title: "GitHub",
    dedupeKey: key,
    createdBy: "jarvis",
  });
  return key;
}
const stateOf = async (key: string) =>
  (await t.tdb.db.select().from(notification).where(eq(notification.dedupeKey, key)))[0]?.state;

describe("reading GitHub in", () => {
  it("reads every pull request changed since last time, a page at a time", async () => {
    g.pageSize = 10;
    await connect();
    await sync();
    t.clock.advance(60_000);
    for (let n = 1; n <= 64; n++) pr(n);
    // Five pages a round: the fifty changed last now, the rest next round.
    expect(await sync()).toMatchObject({ prs: 50, failed: [] });
    const [repo] = await t.tdb.db.select().from(githubRepo);
    expect(repo).toMatchObject({ resumePage: 6 });
    expect(await sync()).toMatchObject({ prs: 14 });
    expect(await prCount()).toBe(64);
    expect((await t.tdb.db.select().from(githubRepo))[0]).toMatchObject({
      resumePage: null,
      backlogTop: null,
    });
    // Then only what changes is read.
    t.clock.advance(60_000);
    pr(7, { state: "merged" });
    expect(await sync()).toMatchObject({ prs: 1 });
  });

  it("says when a pull request is opened, merged or closed, but not for the first look", async () => {
    pr(1);
    await connect();
    await sync();
    expect(await t.events("github.pr_opened")).toEqual([]);
    t.clock.advance(60_000);
    pr(1, { state: "merged" });
    pr(2, { author: "stranger" });
    t.clock.advance(60_000);
    pr(2, { author: "stranger", state: "closed" });
    await sync();
    const [merged] = await t.events("github.pr_merged");
    expect(merged?.payload).toMatchObject({ repo: REPO, number: 1, mine: true });
    expect(merged?.entityId).toBeTruthy();
    // Seen first already closed: it closed, and it was never seen open.
    expect(await t.events("github.pr_closed")).toMatchObject([{ payload: { number: 2 } }]);
    expect(await t.events("github.pr_opened")).toEqual([]);
  });
});

describe("when GitHub stops working", () => {
  it("stops asking once the token stops working, says so once, and a new token carries on", async () => {
    pr(1);
    await connect();
    await sync();
    g.token = "github_pat_rotated_0123456789";
    expect((await sync()).failed).toEqual([`${REPO}: GitHub doesn't accept this token.`]);
    expect(await status()).toMatchObject({ state: "revoked" });
    const asked = g.calls.length;
    await sync();
    expect(g.calls.length).toBe(asked);
    const failed = await t.events("github.sync_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toMatchObject({ reconnect: true });
    const key = await notice(failed[0]!);

    g.login = "someone";
    expect(
      await t.kernel.execute("github.replace_token", { token: g.token }, ownerCaller()),
    ).toMatchObject({ status: "error", code: "invalid_input" });
    g.login = "wally";
    expect(await ok("github.replace_token", { token: g.token })).toMatchObject({
      login: "wally",
    });
    expect(await stateOf(key)).toBe("done");
    t.clock.advance(60_000);
    pr(2);
    expect(await sync()).toMatchObject({ prs: 1, failed: [] });
    expect(await prCount()).toBe(2);
  });

  it("tells you once when GitHub can't be reached for a while, and closes it when it can", async () => {
    await connect();
    await sync();
    const outage = async () => {
      g.failWith = new GithubError(0, "GitHub couldn't be reached.");
      expect((await sync()).failed).toHaveLength(1);
      t.clock.advance(15 * 60_000);
    };
    await outage();
    await outage();
    expect(await t.events("github.sync_failed")).toEqual([]);
    await outage();
    await outage();
    const failed = await t.events("github.sync_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toMatchObject({ reconnect: false });
    const key = await notice(failed[0]!);
    g.failWith = null;
    expect(await sync()).toMatchObject({ failed: [] });
    expect(await stateOf(key)).toBe("done");
    expect(await status()).toMatchObject({ state: "ok", lastError: null });
  });

  it("tells you once, a week ahead, that the token is about to stop working", async () => {
    const expires = new Date(t.clock.now().getTime() + 10 * 86_400_000);
    g.tokenExpiresAt = expires;
    await connect();
    expect(new Date((await status()).tokenExpiresAt!).getTime()).toBe(expires.getTime());
    await sync();
    expect(await t.events("github.token_expiring")).toEqual([]);
    t.clock.advance(4 * 86_400_000);
    await sync();
    t.clock.advance(60_000);
    await sync();
    const warned = await t.events("github.token_expiring");
    expect(warned).toHaveLength(1);
    expect(warned[0]?.payload).toMatchObject({ login: "wally", expiresAt: expires.toISOString() });
    const reflex = githubModule.reflexes.find((r) => r.name === "github.token_expiring")!;
    const [out] = await reflex.run(warned[0]!, { db: t.tdb.db, now: t.clock.now() });
    // GitHub's sync told it, but the card is only Hearth's words: reading it back stays trusted.
    expect(warned[0]?.origin).toBe("untrusted");
    expect(out).toMatchObject({
      notification: { title: "Your GitHub token is about to stop working", outside: false },
    });
  });
});
