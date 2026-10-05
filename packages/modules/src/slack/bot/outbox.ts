// The outbox's sender, run by the worker (D62): the one place Jarvis's posts go out, each once.
//
// - Each post carries its row's id as metadata (OUTBOX_EVENT). A post that may have gone out (no
//   answer, a server error, a row left `sending` by a crash) is read back from where it went: a
//   DM with the bot's token, a channel with your own (you're in every channel Jarvis answers in).
//   Only a post from our bot_id with that id counts; then the row is sent, otherwise it's posted
//   again. A channel Hearth can't read back is marked "may not have gone out", and not retried.
// - Slack's "slow down" is honoured. not_in_channel, is_archived, channel_not_found,
//   msg_too_long and the like fail the row, and you're told.
// - Nothing goes while Slack has the bot revoked: rows wait for new tokens, and a row still
//   waiting after a day expires, and you're told.
import { PRINCIPAL } from "@hearth/core";
import {
  type Db,
  slackAnswer,
  slackBot,
  slackChannel,
  slackThread,
  slackUser,
  slackWorkspace,
} from "@hearth/db";
import {
  appendEvents,
  createNotification,
  type EmitEvent,
  type Kernel,
  newId,
  systemCaller,
} from "@hearth/kernel";
import { and, eq } from "drizzle-orm";
import { preview } from "../../shared.ts";
import { SlackError, type SlackMessage } from "../api.ts";
import { named, openToken, slackApi } from "../save.ts";
import { linksIn, slackText } from "./filter.ts";
import { botTrouble, REVOKED_CODES, saveBotHealth } from "./health.ts";
import {
  claimNext,
  expireWaiting,
  holdQueued,
  type OutboxRow,
  type Settle,
  settle,
} from "./queue.ts";
import { slackTs } from "./socket.ts";
import { type BotRow, botApi, openBotToken } from "./tokens.ts";

/** Most posts one round makes; the worker comes straight back when there's more. */
const ROUND_MAX = 20;
/** A post that kept failing without Slack saying why is given up on. */
const MAX_ATTEMPTS = 6;
/** How far before a row was made a read-back looks, for the PC's clock and Slack's to differ. */
const READ_BACK_SLACK_MS = 5 * 60_000;
/** Slack had trouble of its own: the post may have gone out. */
const UNSURE = /^(http_5\d\d|internal_error|fatal_error|service_unavailable|request_timeout)$/;
/** Your own token can't see the channel: a post there can't be read back. */
const CANT_SEE: ReadonlySet<string> = new Set([
  "not_in_channel",
  "channel_not_found",
  "is_archived",
  "missing_scope",
]);

export interface OutboxRound {
  sent: number;
  failed: number;
  expired: number;
  unknown: number;
  /** Maybe posted: read back in a minute. */
  unsure: number;
  /** Slack asked for a wait: the rest of the round waits too. */
  waiting: number;
  /** Nothing went: Slack has the bot revoked, or its tokens won't open. */
  held: boolean;
  /** The pace held posts back, or the round was full: come back in a second. */
  more: boolean;
}

type Services = { service<T>(name: string): T };

function servicesOf(kernel: Kernel): Services {
  return {
    service: <T>(name: string): T => {
      const s = kernel.services[name];
      if (!s) throw new Error(`The ${name} isn't available in the worker.`);
      return s as T;
    },
  };
}

const isUser = (channel: string) => /^[UW]/.test(channel);

/** One round of sending, for the bot connected in this workspace. */
export async function sendOutbox(kernel: Kernel, max = ROUND_MAX): Promise<OutboxRound> {
  const round: OutboxRound = {
    sent: 0,
    failed: 0,
    expired: 0,
    unknown: 0,
    unsure: 0,
    waiting: 0,
    held: false,
    more: false,
  };
  const [bot] = await kernel.db.select().from(slackBot).limit(1);
  if (!bot) return round;
  for (const row of await expireWaiting(kernel.db, bot.teamId, kernel.clock.now())) {
    round.expired++;
    await tell(kernel, row, "didn't go out", "It waited a day: Jarvis's Slack bot couldn't post.");
  }
  // Held while Slack has the bot revoked: nothing goes until new tokens arrive (D62).
  if (bot.syncState === "revoked") return { ...round, held: true };
  for (let i = 0; ; i++) {
    const claim = i < max ? await claimNext(kernel.db, bot.teamId, kernel.clock.now()) : null;
    if (claim?.kind === "none") break;
    // The pace held something back, or the round is full: come back soon.
    if (!claim || claim.kind === "paced") {
      round.more = true;
      break;
    }
    const outcome = await deliver(kernel, bot, claim.row, claim.recovering);
    if (outcome === "held") return { ...round, held: true };
    round[outcome]++;
    if (outcome === "waiting") break;
  }
  return round;
}

type Outcome = "sent" | "failed" | "expired" | "unknown" | "unsure" | "waiting" | "held";

async function deliver(
  kernel: Kernel,
  bot: BotRow,
  row: OutboxRow,
  recovering: boolean,
): Promise<Outcome> {
  const s = servicesOf(kernel);
  const now = kernel.clock.now();
  const done = async (to: Settle, outcome: Outcome) => {
    await settle(kernel.db, row, to, now);
    return outcome;
  };
  let token: string;
  try {
    token = openBotToken(s, bot, "bot");
  } catch (err) {
    // The vault can't open the bot's token here: hold everything rather than guess.
    const error = err instanceof Error ? err.message : String(err);
    return done(
      recovering ? { state: "sending", error } : { state: "queued", notBefore: now, error },
      "held",
    );
  }
  const api = botApi(s);
  let channel = row.channelId;
  try {
    // The bot's DM with them, opened here, where the bot's token is (D62). Slack gives the same
    // one each time. The row keeps their id, so their posts are paced together and you're told
    // about one by their name.
    if (isUser(channel) && !row.ephemeralTo) channel = await api.openDm(token, row.channelId);
    if (recovering) {
      // An ephemeral note isn't kept by Slack, so it can't be looked for; it isn't sent twice.
      if (row.ephemeralTo)
        return done({ state: "unknown", error: "A note that may not have been seen." }, "unknown");
      const back = await readBack(kernel, s, bot, row, channel);
      if (back.kind === "found") return done({ state: "sent", sentTs: back.ts }, "sent");
      if (back.kind === "unreadable") {
        await tell(kernel, row, "may not have gone out", back.why);
        return done({ state: "unknown", error: back.why }, "unknown");
      }
    }
    if (now >= row.expiresAt) {
      await tell(kernel, row, "didn't go out", "It waited a day: Slack kept failing.");
      return done({ state: "expired", error: "It waited a day without going out." }, "expired");
    }
    if (row.attempts > MAX_ATTEMPTS) {
      await tell(kernel, row, "didn't go out", `Slack kept failing: ${row.error ?? "no answer"}.`);
      return done({ state: "failed", error: row.error ?? "Slack kept failing." }, "failed");
    }
    const text = slackText(
      row.text,
      row.kind === "answer" ? { sharedLinks: await sharedLinks(kernel.db, bot.teamId) } : {},
    );
    const threadTs = row.threadTs ?? undefined;
    if (row.ephemeralTo) {
      await api.postEphemeral(token, { channel, user: row.ephemeralTo, text, threadTs });
      return done({ state: "sent", sentTs: null }, "sent");
    }
    const posted = await api.post(token, { channel, text, threadTs, outboxId: row.id });
    return done({ state: "sent", sentTs: posted.ts }, "sent");
  } catch (err) {
    return failure(kernel, bot, row, recovering, err, done);
  }
}

/** What a failed call means for the post: wait, look again later, stop for new tokens, or fail. */
async function failure(
  kernel: Kernel,
  bot: BotRow,
  row: OutboxRow,
  recovering: boolean,
  err: unknown,
  done: (to: Settle, outcome: Outcome) => Promise<Outcome>,
): Promise<Outcome> {
  const now = kernel.clock.now();
  const said = err instanceof Error ? err.message : String(err);
  if (err instanceof SlackError) {
    // Slack refused it, so it didn't go: it, and everything after it, waits as long as Slack asked.
    if (err.code === "ratelimited") {
      const after = new Date(now.getTime() + (err.retryAfter ?? 60) * 1000);
      const outcome = await done({ state: "queued", notBefore: after, error: said }, "waiting");
      await holdQueued(kernel.db, bot.teamId, after);
      return outcome;
    }
    if (REVOKED_CODES.has(err.code)) {
      await saveBotHealth(kernel.db, bot.teamId, now, {
        trouble: botTrouble(err.code),
        since: now,
      });
      // One that may have gone already is still read back first, once there are new tokens.
      return done(
        recovering
          ? { state: "sending", error: said }
          : { state: "queued", notBefore: now, error: said },
        "held",
      );
    }
    if (!UNSURE.test(err.code)) {
      await tell(kernel, row, "didn't go out", `Slack said ${err.code}.`);
      return done({ state: "failed", error: `Slack said ${err.code}.` }, "failed");
    }
  }
  // No answer, or Slack's own trouble: it may have gone out. A minute on, it's read back.
  return done({ state: "sending", error: said }, "unsure");
}

type ReadBack =
  | { kind: "found"; ts: string }
  | { kind: "absent" }
  | { kind: "unreadable"; why: string };

/** Whether a post that may have gone out did: only our bot's post carrying this row's id counts. */
async function readBack(
  kernel: Kernel,
  s: Services,
  bot: BotRow,
  row: OutboxRow,
  channel: string,
): Promise<ReadBack> {
  const page = {
    oldest: slackTs(new Date(row.createdAt.getTime() - READ_BACK_SLACK_MS)),
    ...(row.threadTs ? { threadTs: row.threadTs } : {}),
  };
  let posts: SlackMessage[];
  if (channel.startsWith("D")) {
    // The bot's DMs: your token can't see them.
    posts = await botApi(s).readBack(openBotToken(s, bot, "bot"), channel, page);
  } else {
    const [ws] = await kernel.db
      .select()
      .from(slackWorkspace)
      .where(eq(slackWorkspace.teamId, bot.teamId));
    if (!ws || ws.syncState === "revoked")
      return {
        kind: "unreadable",
        why: "Your own Slack token isn't working, so Hearth couldn't look.",
      };
    try {
      posts = await slackApi(s).readBack(openToken(s, ws), channel, page);
    } catch (err) {
      if (err instanceof SlackError && CANT_SEE.has(err.code))
        return { kind: "unreadable", why: "You aren't in that channel, so Hearth couldn't look." };
      throw err;
    }
  }
  const ours = posts.find((m) => m.outboxId === row.id && m.botId === bot.botId);
  return ours ? { kind: "found", ts: ours.ts } : { kind: "absent" };
}

/** The links you wrote in your shared answers: the only ones a member's answer may carry. */
async function sharedLinks(db: Db, teamId: string): Promise<Set<string>> {
  const rows = await db
    .select({ body: slackAnswer.body })
    .from(slackAnswer)
    .where(eq(slackAnswer.teamId, teamId));
  return new Set(rows.flatMap((r) => linksIn(r.body)));
}

/** Where a post was going, in words: a member's name, or a channel's. */
async function placeName(db: Db, row: OutboxRow): Promise<string> {
  const id = row.channelId;
  let user: string | null = isUser(id) ? id : null;
  if (id.startsWith("D")) {
    const [t] = await db
      .select({ member: slackThread.member })
      .from(slackThread)
      .where(and(eq(slackThread.channelId, id), eq(slackThread.threadTs, "")));
    const [u] = t?.member
      ? await db
          .select({ id: slackUser.id })
          .from(slackUser)
          .where(eq(slackUser.principal, t.member))
      : [];
    user = u?.id ?? null;
  }
  if (user) {
    const [u] = await db
      .select({ name: slackUser.name })
      .from(slackUser)
      .where(eq(slackUser.id, user));
    return u ? named(u.name) : user;
  }
  if (id.startsWith("D")) return "a direct message";
  const [c] = await db
    .select({ name: slackChannel.name })
    .from(slackChannel)
    .where(eq(slackChannel.id, id));
  return `#${named(c?.name ?? id)}`;
}

/** Tells you about a post that didn't go out, or may not have: one card per post. */
async function tell(kernel: Kernel, row: OutboxRow, what: string, why: string) {
  const now = kernel.clock.now();
  const where = await placeName(kernel.db, row);
  await kernel.db.transaction(async (tx) => {
    const buffered: EmitEvent[] = [];
    const ctx = kernel.context(tx, { ...systemCaller(), correlationId: newId() }, now, buffered);
    await createNotification(ctx, {
      kind: "slack.not_sent",
      title: `Jarvis's Slack message to ${where} ${what}`,
      body: `${why}\n\n${preview(row.text, 300)}`,
      urgency: "normal",
      dedupeKey: `slack.outbox:${row.id}`,
    });
    await appendEvents(tx, buffered, { actor: PRINCIPAL.system, origin: "system", at: now });
  });
}
