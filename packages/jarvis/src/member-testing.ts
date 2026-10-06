// What the Slack member turn tests share (D62): Jarvis's whole spine with a scripted brain, your
// Slack and Jarvis's bot connected the real way against FakeSlack, members on, and Sam Lee, a full
// member, in the workspace. Messages arrive as the socket stores them; the worker's take loop,
// Jarvis's runner and the outbox's sender each run when a test says, on the test's clock.
import { randomBytes } from "node:crypto";
import { jarvisTurn, notification, slackInbound, slackOutbox, slackUser } from "@hearth/db";
import { type Caller, integrationCaller, ownerCaller, setSetting } from "@hearth/kernel";
import {
  FakeSlack,
  INSTALL_SERVICE,
  type OutboxRound,
  SLACK_BOT_SERVICE,
  SLACK_SERVICE,
  type SlackUser,
  sendOutbox,
  storeInbound,
  type TakeRound,
  VAULT_SERVICE,
  Vault,
} from "@hearth/modules";
import { asc, eq } from "drizzle-orm";
import type { TurnRow } from "./claim.ts";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";

export const person = (id: string, more: Partial<SlackUser> = {}): SlackUser => ({
  id,
  name: id.slice(1).toLowerCase(),
  bot: false,
  guest: false,
  deleted: false,
  teamId: "T1",
  ...more,
});

export const SAM = "USAM";
/** Sam's DM with Jarvis's bot, as FakeSlack opens it. */
export const SAM_DM = "DUSAM";

export interface MemberTest {
  h: JarvisHarness;
  s: FakeSlack;
  ok<T>(name: string, input?: unknown, caller?: Caller): Promise<T>;
  /** A message to Jarvis's bot as the socket stores it, now. Returns its ts. */
  write(
    user: string,
    text: string,
    more?: { threadTs?: string; subtype?: "file_share" },
  ): Promise<string>;
  /** One round of the worker's take loop (who's writing, then their messages), now. */
  take(): Promise<TakeRound>;
  /** Two seconds on, then a round: the loop's pace. */
  tick(): Promise<TakeRound>;
  /** Jarvis runs every turn it can. */
  drain(): Promise<number>;
  /** The outbox sends everything it has, a second at a time where the pace says so. */
  send(): Promise<OutboxRound[]>;
  turns(): Promise<TurnRow[]>;
  outbox(): Promise<(typeof slackOutbox.$inferSelect)[]>;
  inbound(): Promise<(typeof slackInbound.$inferSelect)[]>;
  cards(kind?: string): Promise<(typeof notification.$inferSelect)[]>;
  /** Sets what Jarvis does for Sam, as you would in Settings. */
  setSam(patch: { tier?: string; replies?: string; vip?: boolean }): Promise<void>;
}

export async function memberTest(start = "2026-10-05T14:00:00Z"): Promise<MemberTest> {
  const h = await createJarvisHarness(start);
  const s = new FakeSlack();
  s.clock = Math.floor(h.clock.now().getTime() / 1000);
  for (const u of [
    person("UME", { realName: "Ana Owner", email: "ana@acme.example" }),
    person(SAM, { realName: "Sam Lee", email: "sam@acme.example" }),
  ])
    s.users.set(u.id, u);
  h.kernel.services[SLACK_SERVICE] = s.api();
  h.kernel.services[SLACK_BOT_SERVICE] = s.botApi();
  h.kernel.services[VAULT_SERVICE] = new Vault(randomBytes(32));
  h.kernel.services[INSTALL_SERVICE] = { id: () => "install-live" };
  const ok = async <T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) => {
    const res = await h.kernel.execute<T>(name, input, caller);
    if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
    return res.result;
  };
  await ok("slack.connect", { token: s.token });
  await ok("slack.bot_connect", { botToken: s.bot.token, appToken: s.bot.appToken });
  await setSetting(h.tdb.db, "slack.bot.membersOn", true);
  // You, as reading Slack in saves you: the notes say your first name.
  await h.tdb.db
    .insert(slackUser)
    .values({ id: "UME", teamId: "T1", name: "Ana Owner" })
    .onConflictDoNothing();
  let n = 0;
  const take = async () => {
    const slack = integrationCaller("slack");
    await ok("slack.check_members", {}, slack);
    return ok<TakeRound>("slack.take", {}, slack);
  };
  return {
    h,
    s,
    ok,
    async write(user, text, more = {}) {
      const at = h.clock.now().getTime();
      // Unique, and in order, however many arrive in one millisecond.
      const ts = `${Math.floor(at / 1000)}.${String((at % 1000) * 1000 + (n++ % 1000)).padStart(6, "0")}`;
      await storeInbound(h.tdb.db, [
        {
          channelId: `D${user}`,
          ts,
          teamId: "T1",
          userId: user,
          threadTs: more.threadTs ?? null,
          channelType: "im",
          subtype: more.subtype ?? null,
          text,
          source: "event",
          receivedAt: h.clock.now(),
        },
      ]);
      return ts;
    },
    take,
    async tick() {
      h.clock.advance(2000);
      return take();
    },
    drain: () => h.runner.drain(),
    async send() {
      const rounds: OutboxRound[] = [];
      for (let i = 0; i < 60; i++) {
        const r = await sendOutbox(h.kernel);
        rounds.push(r);
        if (!r.more) break;
        h.clock.advance(1100);
      }
      return rounds;
    },
    turns: () =>
      h.tdb.db
        .select()
        .from(jarvisTurn)
        .where(eq(jarvisTurn.trigger, "slack_member"))
        .orderBy(asc(jarvisTurn.queuedAt)),
    outbox: () => h.tdb.db.select().from(slackOutbox).orderBy(asc(slackOutbox.createdAt)),
    inbound: () => h.tdb.db.select().from(slackInbound).orderBy(asc(slackInbound.ts)),
    cards: (kind) =>
      h.tdb.db
        .select()
        .from(notification)
        .where(kind ? eq(notification.kind, kind) : undefined)
        .orderBy(asc(notification.createdAt)),
    async setSam(patch) {
      await ok("slack.member_set", { user: SAM, ...patch });
    },
  };
}
