// The worker's outbox sender (D62): a new post wakes it at once through pg_notify, and it posts only
// where Jarvis's socket would be held, so a copy of Hearth on a restored database never posts.
import { randomBytes } from "node:crypto";
import { type Caller, ownerCaller, setSetting } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import {
  ALL_MODULES,
  FakeSlack,
  INSTALL_SERVICE,
  SLACK_BOT_SERVICE,
  SLACK_SERVICE,
  VAULT_SERVICE,
  Vault,
} from "@hearth/modules";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { until } from "./slack-bot-testing.ts";
import { type SlackOutbox, startSlackOutbox } from "./slack-outbox.ts";

let t: TestKernel;
let s: FakeSlack;
let outbox: SlackOutbox | null = null;
const logs: string[] = [];

async function ok(name: string, input: unknown, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
}
const install = (id: string) => {
  t.kernel.services[INSTALL_SERVICE] = { id: () => id };
};

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  s = new FakeSlack();
  s.users.set("USAM", { id: "USAM", name: "Sam Lee", email: "sam@acme.example", bot: false });
  t.kernel.services[SLACK_SERVICE] = s.api();
  t.kernel.services[SLACK_BOT_SERVICE] = s.botApi();
  t.kernel.services[VAULT_SERVICE] = new Vault(randomBytes(32));
  install("install-live");
  await ok("slack.connect", { token: s.token });
  await ok("slack.bot_connect", { botToken: s.bot.token, appToken: s.bot.appToken });
  await setSetting(t.tdb.db, "slack.bot.membersOn", true);
});
afterEach(async () => {
  await outbox?.stop();
  outbox = null;
  logs.length = 0;
  await t.destroy();
});

/** A sender that only looks when woken: no poll in a test's time, and LISTEN if asked. */
const start = (listen = true) => {
  outbox = startSlackOutbox({
    kernel: t.kernel,
    pool: listen ? t.tdb.pool : undefined,
    pollMs: 3_600_000,
    log: (m, e) => logs.push(e ? `${m}: ${e}` : m),
  });
  return outbox;
};

describe("the worker's Slack outbox", () => {
  it("posts as soon as a post is added, woken by its notify", async () => {
    start();
    // Listening before the post is added: a notify before LISTEN would wait for the poll.
    await until(() => outbox!.listening(), 5000, "LISTEN");
    await ok("slack.dm", { to: "USAM", text: "The build is fixed" });
    await until(() => s.posts.length === 1, 5000, "the post");
    expect(s.posts[0]).toMatchObject({ channel: "DUSAM", text: "The build is fixed" });
    expect(logs).toEqual([]);
  });

  it("doesn't post on another install of Hearth, or before members are on", async () => {
    install("install-copy");
    await ok("slack.dm", { to: "USAM", text: "From the copy" });
    await start(false).wake();
    expect(outbox!.last()).toBeNull();
    await setSetting(t.tdb.db, "slack.bot.membersOn", false);
    install("install-live");
    await outbox!.wake();
    expect(s.posts).toEqual([]);
    // Back on the install that connected the bot, with members on, it goes.
    await setSetting(t.tdb.db, "slack.bot.membersOn", true);
    await outbox!.wake();
    expect(s.posts.map((p) => p.text)).toEqual(["From the copy"]);
  });
});
