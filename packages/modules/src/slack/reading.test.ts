// Slack read in page by page and thread by thread, and what happens when its token stops
// working or Slack keeps failing (6.8, D61).
import { randomBytes, randomUUID } from "node:crypto";
import { entity, notification, slackChannel, slackMessage } from "@hearth/db";
import { type Caller, type HearthEvent, integrationCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VAULT_SERVICE, Vault } from "../browser/vault.ts";
import { ALL_MODULES } from "../index.ts";
import { SLACK_SERVICE } from "./api.ts";
import { FakeSlack } from "./fake.ts";
import { slackModule } from "./index.ts";

let t: TestKernel;
let s: FakeSlack;

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  s = new FakeSlack();
  s.clock = Math.floor(t.clock.now().getTime() / 1000) - 3600;
  s.conversations = [
    { id: "C1", name: "general", kind: "channel" },
    { id: "D1", name: "", kind: "dm", user: "UANA" },
  ];
  s.users.set("UANA", { id: "UANA", name: "Ana", bot: false });
  s.users.set("UBOB", { id: "UBOB", name: "Bob", bot: false });
  t.kernel.services[SLACK_SERVICE] = s.api();
  t.kernel.services[VAULT_SERVICE] = new Vault(randomBytes(32));
});
afterEach(() => t.destroy());

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const sync = () =>
  ok<{ added: number; replies: number; error?: string }>(
    "slack.sync",
    {},
    integrationCaller("slack"),
  );
const connect = () => ok("slack.connect", { token: s.token });
const status = () => ok<{ state: string; lastError: string | null }>("slack.status");
const texts = async (channel: string) =>
  (
    await t.tdb.db
      .select({ text: entity.body })
      .from(slackMessage)
      .innerJoin(entity, eq(entity.id, slackMessage.entityId))
      .where(eq(slackMessage.channelId, channel))
      .orderBy(asc(slackMessage.sentAt))
  ).map((r) => r.text);
const channel = async (id: string) =>
  (await t.tdb.db.select().from(slackChannel).where(eq(slackChannel.id, id)))[0]!;

/** The notice Jarvis writes for an alert event, as it writes it. */
async function notice(e: HearthEvent) {
  const reflex = slackModule.reflexes.find((r) => r.name === "slack.sync_failed")!;
  const [out] = await reflex.run(e, { db: t.tdb.db, now: t.clock.now() });
  const key = (out as { notification: { dedupeKey: string } }).notification.dedupeKey;
  await t.tdb.db.insert(notification).values({
    id: randomUUID(),
    kind: "system.alert",
    title: "Slack isn't syncing",
    dedupeKey: key,
    createdBy: "jarvis",
  });
  return key;
}
const stateOf = async (key: string) =>
  (await t.tdb.db.select().from(notification).where(eq(notification.dedupeKey, key)))[0]?.state;

describe("reading Slack in", () => {
  it("reads a busy channel a page at a time, newest first, and skips nothing", async () => {
    s.pageSize = 10;
    await connect();
    await sync();
    for (let i = 0; i < 80; i++) s.post("C1", "UBOB", `m${i}`);

    // Five pages a round: the newest fifty now, the thirty before them next round.
    expect((await sync()).added).toBe(50);
    expect(await texts("C1")).toEqual(Array.from({ length: 50 }, (_, i) => `m${i + 30}`));
    expect((await channel("C1")).backlogTs).not.toBeNull();
    expect((await sync()).added).toBe(30);
    expect(await texts("C1")).toHaveLength(80);
    expect(await channel("C1")).toMatchObject({ backlogTs: null, backlogTop: null });

    s.post("C1", "UBOB", "late");
    expect((await sync()).added).toBe(1);
    expect((await texts("C1")).at(-1)).toBe("late");
  });

  it("reads replies in threads, also new ones in a thread started before", async () => {
    const lunch = s.post("C1", "UBOB", "Lunch?");
    await connect();
    await sync();
    // A thread started since comes in with its replies.
    const deploy = s.post("C1", "UANA", "Deploy today?");
    s.post("C1", "UBOB", "Yes, at 3", deploy);
    // A reply to an older message doesn't bring it back into the channel's history.
    s.post("C1", "UANA", "Count me in", lunch);
    s.post("C1", "UBOB", "<@UME> you too?", lunch);
    expect((await sync()).replies).toBe(1);
    expect(await texts("C1")).not.toContain("Count me in");

    // Now and then the last few days are looked over for threads with new replies.
    t.clock.advance(11 * 60_000);
    expect((await sync()).replies).toBe(1);
    const rows = await t.tdb.db
      .select({ text: entity.body, parentId: entity.parentId, id: entity.id })
      .from(entity)
      .where(eq(entity.type, "slack_message"));
    const byText = new Map(rows.map((r) => [r.text, r]));
    expect(byText.get("Count me in")?.parentId).toBe(byText.get("Lunch?")?.id);
    expect(byText.get("Yes, at 3")?.parentId).toBe(byText.get("Deploy today?")?.id);
    // The mention in the thread came in once, and told you once.
    const mentions = (await ok<{ notification: { kind: string } }[]>("inbox.list")).filter(
      (i) => i.notification.kind === "slack.mention",
    );
    expect(mentions).toHaveLength(1);

    // Read once: the next look reads nothing again.
    t.clock.advance(11 * 60_000);
    expect((await sync()).replies).toBe(0);
  });
});

describe("when Slack stops working", () => {
  it("stops asking once the token is revoked, says so once, and a new token carries on", async () => {
    s.post("C1", "UBOB", "before");
    await connect();
    await sync();
    s.failWith = "token_revoked";
    expect((await sync()).error).toMatch(/revoked/);
    expect(await status()).toMatchObject({ state: "revoked" });
    const asked = s.requests;
    expect((await sync()).error).toMatch(/revoked/);
    expect(s.requests).toBe(asked);
    const failed = await t.events("slack.sync_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toMatchObject({ reconnect: true });
    const key = await notice(failed[0]!);

    s.failWith = null;
    s.token = "xoxp-3333-4444-new";
    s.me = "UOTHER";
    expect(
      await t.kernel.execute("slack.replace_token", { token: s.token }, ownerCaller()),
    ).toMatchObject({ status: "error", code: "invalid_input" });
    s.me = "UME";
    expect(await ok("slack.replace_token", { token: s.token })).toMatchObject({ team: "Acme" });
    expect(await stateOf(key)).toBe("done");
    expect(await status()).toMatchObject({ state: "ok", lastError: null });
    // Connecting the same workspace again just takes the token; nothing read in goes.
    await connect();
    s.post("C1", "UBOB", "after");
    expect((await sync()).added).toBe(1);
    expect(await texts("C1")).toEqual(["before", "after"]);
  });

  it("tells you once when Slack keeps failing, and closes the notice when it syncs again", async () => {
    await connect();
    await sync();
    const outage = async () => {
      s.failWith = "internal_error";
      expect((await sync()).error).toBeDefined();
      t.clock.advance(15 * 60_000);
    };
    await outage();
    await outage();
    // Two failures in half an hour are left alone.
    expect(await t.events("slack.sync_failed")).toEqual([]);
    expect(await status()).toMatchObject({ state: "ok" });
    await outage();
    await outage();
    const failed = await t.events("slack.sync_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toMatchObject({ reconnect: false });
    expect(await status()).toMatchObject({ state: "failing" });
    const key = await notice(failed[0]!);

    s.failWith = null;
    expect((await sync()).error).toBeUndefined();
    expect(await stateOf(key)).toBe("done");
    expect(await status()).toMatchObject({ state: "ok", lastError: null });
    // Jarvis getting to the alert only now says nothing.
    const reflex = slackModule.reflexes.find((r) => r.name === "slack.sync_failed")!;
    expect(await reflex.run(failed[0]!, { db: t.tdb.db, now: t.clock.now() })).toEqual([]);
  });
});
