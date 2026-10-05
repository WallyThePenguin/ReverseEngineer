// What the Slack socket tests share (D62): a kernel with your Slack and Jarvis's bot connected the
// real way, against FakeSlack and a FakeSlackSocket, members on, and a worker's socket started
// with quick pings and waits that are noted instead of slept.
//
// A pong or a hello comes back through the same event loop as the timer waiting for it, so those
// waits are seconds long here: a GC pause or a busy CI runner (#44: Windows runs the suite 2.5
// times slower) mustn't end a healthy socket. Only the test of a socket that stops answering
// waits just 100 ms for a pong.
import { randomBytes } from "node:crypto";
import { notification, slackBot, slackInbound } from "@hearth/db";
import { type Caller, ownerCaller, setSetting } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import {
  ALL_MODULES,
  FakeSlack,
  INSTALL_SERVICE,
  type InboundRow,
  type InboundStore,
  inboundStore,
  SLACK_BOT_SERVICE,
  SLACK_SERVICE,
  VAULT_SERVICE,
  Vault,
} from "@hearth/modules";
import { asc, eq } from "drizzle-orm";
import { FakeSlackSocket } from "./fake-slack-socket.ts";
import { type SlackBot, type SlackBotOptions, startSlackBot } from "./slack-bot.ts";

export interface BotTest {
  t: TestKernel;
  s: FakeSlack;
  fake: FakeSlackSocket;
  /** The ack path's store; `failNext` makes the next writes fail, as a busy database would. */
  inbound: InboundStore & { failNext: number };
  /** Every wait between tries, in ms. */
  waits: number[];
  logs: string[];
  /** The clock a socket's time up is measured on. */
  elapsed: { ms: number };
  bot: SlackBot | null;
  start(over?: Partial<SlackBotOptions>): SlackBot;
  rows(): Promise<InboundRow[]>;
  row(): Promise<typeof slackBot.$inferSelect>;
  alerts(): Promise<{ title: string }[]>;
  done(): Promise<void>;
}

export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until `ok` holds, checking every 10 ms. */
export async function until(ok: () => boolean | Promise<boolean>, ms = 5000, what = "it") {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`Gave up waiting for ${what}`);
    await pause(10);
  }
}

export async function botTest(): Promise<BotTest> {
  const t = await createTestKernel(ALL_MODULES);
  const s = new FakeSlack();
  const fake = await FakeSlackSocket.start();
  t.kernel.services[SLACK_SERVICE] = s.api();
  t.kernel.services[SLACK_BOT_SERVICE] = fake.api(s.botApi());
  t.kernel.services[VAULT_SERVICE] = new Vault(randomBytes(32));
  t.kernel.services[INSTALL_SERVICE] = { id: () => "install-live" };
  const ok = async (name: string, input: unknown, caller: Caller = ownerCaller()) => {
    const res = await t.kernel.execute(name, input, caller);
    if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  };
  await ok("slack.connect", { token: s.token });
  await ok("slack.bot_connect", { botToken: s.bot.token, appToken: s.bot.appToken });
  await setSetting(t.tdb.db, "slack.bot.membersOn", true);
  // Connecting looked at a socket once; the tests count from here.
  fake.opens = 0;

  // Never the live database: the test's own, on a connection of its own as the worker's is.
  const real = inboundStore(t.tdb.url);
  const inbound = {
    failNext: 0,
    async store(rows: InboundRow[]) {
      if (inbound.failNext > 0) {
        inbound.failNext--;
        throw new Error("canceling statement due to statement timeout");
      }
      return real.store(rows);
    },
    close: () => real.close(),
  };
  const k: BotTest = {
    t,
    s,
    fake,
    inbound,
    waits: [],
    logs: [],
    elapsed: { ms: 0 },
    bot: null,
    start(over = {}) {
      k.bot = startSlackBot({
        kernel: t.kernel,
        inbound,
        log: (m, e) => k.logs.push(e ? `${m}: ${e}` : m),
        // Only when a test asks.
        checkEveryMs: 3_600_000,
        catchUpEveryMs: 3_600_000,
        pingEveryMs: 100,
        pongWaitMs: 5000,
        helloWaitMs: 10_000,
        random: () => 0.5,
        sleep: async (ms) => {
          k.waits.push(ms);
          await pause(5);
        },
        elapsed: () => k.elapsed.ms,
        ...over,
      });
      return k.bot;
    },
    rows: () => t.tdb.db.select().from(slackInbound).orderBy(asc(slackInbound.ts)),
    row: async () => (await t.tdb.db.select().from(slackBot))[0]!,
    alerts: () =>
      t.tdb.db
        .select({ title: notification.title })
        .from(notification)
        .where(eq(notification.kind, "system.alert")),
    async done() {
      k.bot?.stop();
      await inbound.close();
      await fake.close();
      await t.destroy();
    },
  };
  return k;
}
