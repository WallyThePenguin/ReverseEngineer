// The worker's take loop (D62): it takes members' messages without Jarvis, so with Jarvis down a
// member still hears back, and you still get their message. It runs only on the install that
// holds the bot, and a refused lookup in Slack waits a minute before asking again.
import { randomBytes } from "node:crypto";
import { jarvisTurn, notification, slackInbound, slackUser } from "@hearth/db";
import { type Caller, ownerCaller, setSetting } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import {
  ALL_MODULES,
  FakeSlack,
  INSTALL_SERVICE,
  SLACK_BOT_SERVICE,
  SLACK_SERVICE,
  sendOutbox,
  storeInbound,
  VAULT_SERVICE,
  Vault,
} from "@hearth/modules";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SlackTake, startSlackTake } from "./slack-take.ts";

let t: TestKernel;
let s: FakeSlack;
let take: SlackTake;
const logs: string[] = [];
let n = 0;

async function ok(name: string, input: unknown, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
}
const install = (id: string) => {
  t.kernel.services[INSTALL_SERVICE] = { id: () => id };
};

/** Sam writes to Jarvis's bot, as the socket stores it. */
async function samWrites(text: string) {
  const at = t.clock.now().getTime();
  const ts = `${Math.floor(at / 1000)}.${String(++n).padStart(6, "0")}`;
  await storeInbound(t.tdb.db, [
    {
      channelId: "DUSAM",
      ts,
      teamId: "T1",
      userId: "USAM",
      threadTs: null,
      channelType: "im",
      subtype: null,
      text,
      source: "event",
      receivedAt: t.clock.now(),
    },
  ]);
}
const inbound = () => t.tdb.db.select().from(slackInbound);

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES, "2026-10-05T14:00:00Z");
  s = new FakeSlack();
  s.clock = Math.floor(t.clock.now().getTime() / 1000);
  s.users.set("UME", { id: "UME", name: "ana", realName: "Ana Owner", bot: false, teamId: "T1" });
  s.users.set("USAM", { id: "USAM", name: "sam", realName: "Sam Lee", bot: false, teamId: "T1" });
  t.kernel.services[SLACK_SERVICE] = s.api();
  t.kernel.services[SLACK_BOT_SERVICE] = s.botApi();
  t.kernel.services[VAULT_SERVICE] = new Vault(randomBytes(32));
  install("install-live");
  await ok("slack.connect", { token: s.token });
  await ok("slack.bot_connect", { botToken: s.bot.token, appToken: s.bot.appToken });
  await setSetting(t.tdb.db, "slack.bot.membersOn", true);
  await t.tdb.db.insert(slackUser).values({ id: "UME", teamId: "T1", name: "Ana Owner" });
  // Rounds only when a test runs one.
  take = startSlackTake({
    kernel: t.kernel,
    everyMs: 3_600_000,
    log: (m, e) => logs.push(e ? `${m}: ${e}` : m),
  });
});
afterEach(async () => {
  await take.stop();
  logs.length = 0;
  await t.destroy();
});

describe("the worker's take loop", () => {
  it("with Jarvis down for eleven minutes, sends the apology and passes the message on", async () => {
    await samWrites("Is the release still on for today?");
    t.clock.advance(2000);
    expect(await take.round()).toMatchObject({ taken: 1, turns: 1 });
    // No Jarvis runs here: the turn waits, and then it's too late.
    t.clock.advance(11 * 60_000);
    expect(await take.round()).toMatchObject({ relayed: 1 });
    const [turn] = await t.tdb.db.select().from(jarvisTurn);
    expect(turn).toMatchObject({ status: "skipped", skipReason: "expired" });
    expect((await inbound()).map((r) => r.outcome)).toEqual(["relayed"]);
    const [card] = await t.tdb.db
      .select()
      .from(notification)
      .where(eq(notification.kind, "slack.member"));
    expect(card!.body).toContain("Is the release still on for today?");
    await sendOutbox(t.kernel);
    expect(s.posts).toEqual([
      expect.objectContaining({
        channel: "DUSAM",
        text: "Sorry, I couldn't answer this time. I've passed your message on to Ana.",
      }),
    ]);
    expect(logs).toEqual([]);
  });

  it("takes nothing on a copy of Hearth", async () => {
    install("install-copy");
    await samWrites("Hello");
    t.clock.advance(2000);
    expect(await take.round()).toBeNull();
    expect((await inbound()).map((r) => r.outcome)).toEqual([null]);
  });

  it("asks Slack who's writing again only a minute after it refused", async () => {
    await samWrites("Hello");
    t.clock.advance(2000);
    s.failWith = "ratelimited";
    expect(await take.round()).toMatchObject({ taken: 0 });
    expect(logs).toEqual([expect.stringContaining("paused a minute")]);
    s.failWith = null;
    const asked = s.requests;
    t.clock.advance(2000);
    // Still cooling down: no lookup, so Sam's message waits.
    expect(await take.round()).toMatchObject({ taken: 0 });
    expect(s.requests).toBe(asked);
    t.clock.advance(60_000);
    expect(await take.round()).toMatchObject({ taken: 1, turns: 1 });
  });
});
