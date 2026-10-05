// When Jarvis's Slack socket listens, waits and stops (D62): only on the install that connected
// the bot and once members are on; after a failure it waits as the ladder says and as long as
// Slack asks; revoked, it stops, you're told once, and only new tokens start it again. Each hello
// catches up, and the first one starts at now.
import { slackChannel, slackInbound } from "@hearth/db";
import { ownerCaller, setSetting } from "@hearth/kernel";
import { INSTALL_SERVICE } from "@hearth/modules";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reportHealth } from "./health.ts";
import { type BotTest, botTest, pause, until } from "./slack-bot-testing.ts";
import { checkSyncs, ErrorClock } from "./sync-health.ts";

let k: BotTest;
beforeEach(async () => {
  k = await botTest();
});
afterEach(() => k.done());

describe("where it listens", () => {
  it("listens only once members are on, and only on the install that connected the bot", async () => {
    await setSetting(k.t.tdb.db, "slack.bot.membersOn", false);
    const bot = k.start();
    await bot.check();
    await pause(100);
    expect(k.fake.opens).toBe(0);

    // A dev copy on a restored database: same row, another install.
    await setSetting(k.t.tdb.db, "slack.bot.membersOn", true);
    k.t.kernel.services[INSTALL_SERVICE] = { id: () => "a-dev-copy" };
    await bot.check();
    await pause(100);
    expect(k.fake.opens).toBe(0);
    expect(k.logs).toContain(
      "Jarvis's Slack bot was connected on another install of Hearth; not listening here.",
    );

    k.t.kernel.services[INSTALL_SERVICE] = { id: () => "install-live" };
    await bot.check();
    await until(() => bot.connected(), 5000, "the socket");
    expect(k.fake.opens).toBe(1);
    // Turned off again, it lets go of the socket.
    await setSetting(k.t.tdb.db, "slack.bot.membersOn", false);
    await bot.check();
    await until(() => k.fake.sockets[0]!.readyState === k.fake.sockets[0]!.CLOSED);
    expect(bot.connected()).toBe(false);
  });
});

describe("revoked", () => {
  const cases = {
    "Socket Mode turned off (link_disabled)": async () => {
      k.start();
      await k.fake.socket(1);
      await until(() => k.bot!.connected());
      k.fake.disconnect("link_disabled");
    },
    "tokens Slack no longer accepts (invalid_auth)": async () => {
      k.fake.refusals.push({ code: "invalid_auth" });
      k.start();
    },
    "the app uninstalled (app_uninstalled)": async () => {
      k.start();
      await k.fake.socket(1);
      await until(() => k.bot!.connected());
      await k.fake.acked(k.fake.send(k.fake.payload({ type: "app_uninstalled" })));
    },
  };

  for (const [what, revoke] of Object.entries(cases))
    it(`stops for ${what}, tells you once, and waits for new tokens`, async () => {
      await revoke();
      await until(async () => (await k.row()).syncState === "revoked", 5000, "revoked");
      const opens = k.fake.opens;
      for (let i = 0; i < 3; i++) {
        await k.bot!.check();
        await pause(50);
      }
      expect(k.fake.opens).toBe(opens);
      expect(k.waits).toEqual([]);
      expect(k.bot!.connected()).toBe(false);

      // The worker's health check, minute after minute: one alert.
      for (let i = 0; i < 3; i++) {
        await reportHealth(k.t.kernel, await checkSyncs(k.t.kernel, new ErrorClock()));
        k.t.clock.advance(60_000);
      }
      expect(await k.alerts()).toEqual([{ title: "Jarvis's Slack bot is failing" }]);

      // New tokens start it again.
      k.t.clock.advance(60_000);
      const res = await k.t.kernel.execute(
        "slack.bot_replace_tokens",
        { botToken: k.s.bot.token, appToken: k.s.bot.appToken },
        ownerCaller(),
      );
      expect(res.status).toBe("ok");
      await k.bot!.check();
      await until(() => k.bot!.connected(), 5000, "the socket after new tokens");
    });
});

describe("waiting between tries", () => {
  it("waits 1, 2, 5, 15… seconds, as long as Slack's Retry-After asks, and starts over after five minutes up", async () => {
    k.fake.refusals.push(
      { code: "ratelimited", retryAfter: 7 },
      { code: "internal_error" },
      { code: "internal_error" },
      { code: "internal_error" },
    );
    k.start();
    await until(() => k.bot!.connected(), 5000, "the socket");
    // The first try is at once; Retry-After outweighs the ladder's 1 s.
    expect(k.waits).toEqual([7000, 2000, 5000, 15_000]);
    expect(await k.row()).toMatchObject({ syncState: "ok", failures: 0, lastError: null });

    // Up for six minutes, then dropped: the ladder starts over.
    k.elapsed.ms += 6 * 60_000;
    k.fake.latest.terminate();
    await k.fake.socket(2);
    await until(() => k.bot!.connected());
    expect(k.waits.slice(4)).toEqual([1000]);
    // Dropped again at once: it carries on up the ladder.
    k.fake.latest.terminate();
    await k.fake.socket(3);
    await until(() => k.bot!.connected());
    expect(k.waits.slice(5)).toEqual([2000]);
  });
});

describe("catching up on hello", () => {
  it("starts at now on the first hello, and reads back what it missed on the next", async () => {
    const now = Math.floor(k.t.clock.now().getTime() / 1000);
    k.s.clock = now - 600;
    k.s.ims.set("UANA", "DUANA");
    k.s.post("DUANA", "UANA", "said before Jarvis listened");
    k.start();
    await until(async () => (await k.row()).listenFrom !== null, 5000, "the first catch-up");
    expect(await k.rows()).toEqual([]);

    // Down for half an hour, during which Ana writes twice and someone @mentions Jarvis.
    k.bot!.stop();
    k.t.clock.advance(30 * 60_000);
    k.s.clock = now + 60;
    k.s.post("DUANA", "UANA", "are you there?");
    k.s.post("DUANA", "UANA", "hello?");
    await k.t.tdb.db.insert(slackChannel).values({
      id: "C1",
      teamId: "T1",
      name: "general",
      kind: "channel",
      jarvisTier: "relay",
      jarvisReplies: "review",
    });
    const top = k.s.post("C1", "UBEN", "standup");
    k.s.post("C1", "UBEN", "<@UJARVIS> what's the plan?", top);
    k.start();
    await until(async () => (await k.rows()).length === 3, 5000, "catch-up");
    const rows = await k.t.tdb.db
      .select()
      .from(slackInbound)
      .where(eq(slackInbound.source, "catchup"))
      .orderBy(slackInbound.ts);
    expect(rows.map((r) => [r.channelId, r.text, r.threadTs])).toEqual([
      ["DUANA", "are you there?", null],
      ["DUANA", "hello?", null],
      ["C1", "<@UJARVIS> what's the plan?", top],
    ]);
  });
});
