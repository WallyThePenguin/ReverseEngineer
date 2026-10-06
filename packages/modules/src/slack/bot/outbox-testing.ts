// What the "tell Sam" and outbox tests share (D62): your Slack and Jarvis's bot connected the real
// way against FakeSlack, members on, and a workspace with Sam, a guest and two channels, one of
// which Jarvis was invited to. FakeSlack's clock starts at the kernel's, so a read-back looks
// where the posts are.
import { randomBytes } from "node:crypto";
import { notification, slackChannel, slackOutbox, slackUser } from "@hearth/db";
import { type Caller, type ExecuteResult, newId, ownerCaller, setSetting } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { asc, eq } from "drizzle-orm";
import { VAULT_SERVICE, Vault } from "../../browser/vault.ts";
import { ALL_MODULES } from "../../index.ts";
import { INSTALL_SERVICE } from "../../install.ts";
import { SLACK_SERVICE, type SlackUser } from "../api.ts";
import { FakeSlack } from "../fake.ts";
import { SLACK_BOT_SERVICE } from "./api.ts";
import { type OutboxRound, sendOutbox } from "./outbox.ts";
import { enqueue, type NewPost, type OutboxRow } from "./queue.ts";

const person = (id: string, more: Partial<SlackUser>): SlackUser => ({
  id,
  name: id.toLowerCase(),
  bot: false,
  guest: false,
  deleted: false,
  teamId: "T1",
  ...more,
});

export const ME = person("UME", { name: "ana", realName: "Ana Owner", email: "ana@acme.example" });
export const SAM = person("USAM", { name: "sam", realName: "Sam Lee", email: "sam@acme.example" });
export const GUS = person("UGUS", {
  name: "gus",
  realName: "Gus Guest",
  email: "gus@partner.example",
  guest: true,
});

export interface SendTest {
  t: TestKernel;
  s: FakeSlack;
  run(name: string, input?: unknown, caller?: Caller): Promise<ExecuteResult>;
  ok<T>(name: string, input?: unknown, caller?: Caller): Promise<T>;
  /** Adds a post to the outbox as your own send would. */
  queue(post: Partial<NewPost> & { channelId: string }): Promise<OutboxRow>;
  /** One round of the worker's sender. */
  round(): Promise<OutboxRound>;
  rows(): Promise<OutboxRow[]>;
  /** What you were told about posts that didn't go out. */
  told(): Promise<{ title: string; body: string | null }[]>;
}

export async function sendTest(): Promise<SendTest> {
  const t = await createTestKernel(ALL_MODULES);
  const s = new FakeSlack();
  s.clock = Math.floor(t.clock.now().getTime() / 1000);
  for (const u of [ME, SAM, GUS, person("UJARVIS", { name: "jarvis", bot: true })])
    s.users.set(u.id, u);
  s.channel("CGEN", "general", ["UME", "USAM", "UGUS", "UJARVIS"]);
  s.channel("CRAND", "random", ["UME", "USAM"]);
  t.kernel.services[SLACK_SERVICE] = s.api();
  t.kernel.services[SLACK_BOT_SERVICE] = s.botApi();
  t.kernel.services[VAULT_SERVICE] = new Vault(randomBytes(32));
  t.kernel.services[INSTALL_SERVICE] = { id: () => "install-live" };
  const run = (name: string, input: unknown = {}, caller: Caller = ownerCaller()) =>
    t.kernel.execute(name, input, caller);
  const ok = async <T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) => {
    const res = await run(name, input, caller);
    if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
    return res.result as T;
  };
  await ok("slack.connect", { token: s.token });
  await ok("slack.bot_connect", { botToken: s.bot.token, appToken: s.bot.appToken });
  await setSetting(t.tdb.db, "slack.bot.membersOn", true);
  // As reading Slack in would have saved them: how you're told where a post was going.
  await t.tdb.db.insert(slackUser).values({ id: "USAM", teamId: "T1", name: "Sam Lee" });
  await t.tdb.db.insert(slackChannel).values([
    { id: "CGEN", teamId: "T1", name: "general", kind: "channel" },
    { id: "CRAND", teamId: "T1", name: "random", kind: "channel" },
  ]);
  return {
    t,
    s,
    run,
    ok,
    queue: async (post) =>
      (
        await t.tdb.db.transaction((tx) =>
          enqueue(
            { tx, now: t.clock.now(), caller: ownerCaller() },
            { dedupeKey: newId(), teamId: "T1", text: "Hello", kind: "send", ...post },
          ),
        )
      ).row,
    round: () => sendOutbox(t.kernel),
    rows: () =>
      t.tdb.db.select().from(slackOutbox).orderBy(asc(slackOutbox.createdAt), asc(slackOutbox.id)),
    told: () =>
      t.tdb.db
        .select({ title: notification.title, body: notification.body })
        .from(notification)
        .where(eq(notification.kind, "slack.not_sent")),
  };
}
