// The outbox's sender, run by the worker (D62): the one place Jarvis's posts go out, each once.
//
// - Each post carries its row's id as metadata (OUTBOX_EVENT). A post that may have gone out (no
//   answer, a server error, a row left `sending` by a crash) is read back from where it went: a
//   DM with the bot's token, a channel with your own (you're in every channel Jarvis answers in).
//   Only a post from our bot_id with that id counts; then the row is sent, otherwise it's posted
//   again. Until a read-back has looked, nothing posts it again or says it didn't go: a read-back
//   Slack asks to wait, or that fails, is tried again later. One Hearth can't make (you left the
//   channel, Slack refuses, a day of trying) is marked "may not have gone out", and not retried.
// - Slack's "slow down" is honoured. not_in_channel, is_archived, channel_not_found,
//   msg_too_long and the like fail the row, and you're told.
// - Nothing goes while Slack has the bot revoked: rows wait for new tokens, and a row still
//   waiting after a day expires, and you're told. Your own token failing a read-back is never
//   taken for the bot's.
// - A member's answer, or a note, is checked once more as it goes, since it may have waited
//   (member/recheck.ts): to someone you blocked since, or with members off, it doesn't go.
import { type Db, slackAnswer, slackBot, slackWorkspace } from "@hearth/db";
import type { Kernel } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { SlackError, type SlackMessage } from "../api.ts";
import { answerStopped, noteStopped } from "../member/recheck.ts";
import { openToken, slackApi } from "../save.ts";
import { linksIn, slackText } from "./filter.ts";
import { botTrouble, REVOKED_CODES, saveBotHealth } from "./health.ts";
import { isUser, tell } from "./not-sent.ts";
import {
  claimNext,
  expireWaiting,
  giveUpLooking,
  holdQueued,
  type OutboxRow,
  type Settle,
  settle,
} from "./queue.ts";
import { slackTs } from "./socket.ts";
import { type BotRow, botApi, openBotToken } from "./tokens.ts";

/** Most posts one round makes; the worker comes straight back when there's more. */
const ROUND_MAX = 20;
/** A post that kept failing without Slack saying why, or couldn't be looked for, is given up on. */
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
const OWN_TOKEN_BROKEN = "Your own Slack token isn't working, so Hearth couldn't look.";

export interface OutboxRound {
  sent: number;
  failed: number;
  expired: number;
  unknown: number;
  /** Maybe posted: read back in a minute, or once Slack lets it. */
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
  // Held while Slack has the bot revoked: nothing goes until new tokens arrive (D62). Nothing can
  // be read back either, so a post that may have gone out is given up on a day on, and you're told.
  if (bot.syncState === "revoked") {
    for (const row of await giveUpLooking(kernel.db, bot.teamId, kernel.clock.now())) {
      round.unknown++;
      await tell(kernel, row, "may not have gone out", row.error ?? "");
    }
    return { ...round, held: true };
  }
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
  // Whether the post may be out already: a row cut short, until a read-back finds it isn't. Till
  // then nothing posts it again or says it didn't go (D62).
  let maybeOut = recovering;
  let token: string;
  try {
    token = openBotToken(s, bot, "bot");
  } catch (err) {
    // The vault can't open the bot's token here: hold everything rather than guess.
    const error = err instanceof Error ? err.message : String(err);
    if (maybeOut) return couldntLook(kernel, row, done, error, { held: true });
    return done({ state: "queued", notBefore: now, error }, "held");
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
      if (back.kind === "unreadable") return gaveUp(kernel, row, done, back.why);
      // It isn't there, so it didn't go out: from here it's posted like any other.
      maybeOut = false;
    }
    if (now >= row.expiresAt) {
      await tell(kernel, row, "didn't go out", "It waited a day: Slack kept failing.");
      return done({ state: "expired", error: "It waited a day without going out." }, "expired");
    }
    if (row.attempts > MAX_ATTEMPTS) {
      await tell(kernel, row, "didn't go out", `Slack kept failing: ${row.error ?? "no answer"}.`);
      return done({ state: "failed", error: row.error ?? "Slack kept failing." }, "failed");
    }
    const stopped = await answerStopped(kernel.db, row, now);
    if (stopped) {
      await tell(kernel, row, "didn't go out", stopped);
      return done({ state: "failed", error: stopped }, "failed");
    }
    if (await noteStopped(kernel.db, row))
      return done(
        { state: "failed", error: "Not sent: members are off, or they're blocked." },
        "failed",
      );
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
    return failure(kernel, bot, row, maybeOut, err, done);
  }
}

type Done = (to: Settle, outcome: Outcome) => Promise<Outcome>;

/**
 * What a failed call means for the post: wait, look again later, stop for new tokens, or fail.
 * `maybeOut`: the call was looking for a post that may have gone out. Then it's neither queued,
 * which would post it again without looking, nor said not to have gone, which would have you send
 * it again by hand: it's looked for again, or you're told it may not have gone out (D62).
 */
async function failure(
  kernel: Kernel,
  bot: BotRow,
  row: OutboxRow,
  maybeOut: boolean,
  err: unknown,
  done: Done,
): Promise<Outcome> {
  const now = kernel.clock.now();
  const said = err instanceof Error ? err.message : String(err);
  if (err instanceof SlackError) {
    if (err.code === "ratelimited") {
      const after = new Date(now.getTime() + (err.retryAfter ?? 60) * 1000);
      // A read-back that has to wait looks again then. Slack limits reading apart from posting,
      // and your own token's reads share your poller's limit, so posts queued behind don't wait.
      if (maybeOut) return couldntLook(kernel, row, done, said, { notBefore: after });
      // Slack refused it, so it didn't go: it, and everything after it, waits as long as Slack asked.
      const outcome = await done({ state: "queued", notBefore: after, error: said }, "waiting");
      await holdQueued(kernel.db, bot.teamId, after);
      return outcome;
    }
    // Only the bot's token gets here: readBack keeps your own token's trouble to itself.
    if (REVOKED_CODES.has(err.code)) {
      await saveBotHealth(kernel.db, bot.teamId, now, {
        trouble: botTrouble(err.code),
        since: now,
      });
      // One that may have gone already is still read back first, once there are new tokens.
      if (maybeOut) return couldntLook(kernel, row, done, said, { held: true });
      return done({ state: "queued", notBefore: now, error: said }, "held");
    }
    if (!UNSURE.test(err.code)) {
      const why = `Slack said ${err.code}.`;
      if (maybeOut) return gaveUp(kernel, row, done, `${why} Hearth couldn't look for it.`);
      await tell(kernel, row, "didn't go out", why);
      return done({ state: "failed", error: why }, "failed");
    }
  }
  // No answer, or Slack's own trouble: it may have gone out. A minute on, it's read back.
  if (maybeOut) return couldntLook(kernel, row, done, said);
  return done({ state: "sending", error: said }, "unsure");
}

/**
 * Hearth couldn't look for a post that may have gone out. It stays `sending`, to be read back in
 * a minute, or once Slack lets it (`notBefore`), and is never posted blind (D62). A day on, or
 * after MAX_ATTEMPTS tries, it's given up on and you're told; while it's `held` for the bot's
 * tokens, only the day counts.
 */
function couldntLook(
  kernel: Kernel,
  row: OutboxRow,
  done: Done,
  said: string,
  opts: { notBefore?: Date; held?: boolean } = {},
): Promise<Outcome> {
  const now = kernel.clock.now();
  if (now >= row.expiresAt || (!opts.held && row.attempts >= MAX_ATTEMPTS))
    return gaveUp(kernel, row, done, `Hearth couldn't look for it: ${said}`);
  const notBefore = opts.notBefore ? { notBefore: opts.notBefore } : {};
  return done({ state: "sending", error: said, ...notBefore }, opts.held ? "held" : "unsure");
}

/** A post that may have gone out, given up on: it's "may not have gone out", and you're told. */
async function gaveUp(kernel: Kernel, row: OutboxRow, done: Done, why: string) {
  await tell(kernel, row, "may not have gone out", why);
  return done({ state: "unknown", error: why }, "unknown");
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
    if (!ws || ws.syncState === "revoked") return { kind: "unreadable", why: OWN_TOKEN_BROKEN };
    try {
      posts = await slackApi(s).readBack(openToken(s, ws), channel, page);
    } catch (err) {
      // Your own token's trouble is never the bot's: a revoked xoxp mustn't stop the bot or
      // have you paste its tokens again. Your poller tells you about your token (D61). Only a
      // wait or Slack's own trouble is worth looking again for.
      if (!(err instanceof SlackError) || err.code === "ratelimited" || UNSURE.test(err.code))
        throw err;
      return { kind: "unreadable", why: ownTokenCant(err) };
    }
  }
  const ours = posts.find((m) => m.outboxId === row.id && m.botId === bot.botId);
  return ours ? { kind: "found", ts: ours.ts } : { kind: "absent" };
}

/** Why your own token couldn't read a channel back, in words. */
function ownTokenCant(err: SlackError): string {
  if (CANT_SEE.has(err.code)) return "You aren't in that channel, so Hearth couldn't look.";
  if (err.revoked) return OWN_TOKEN_BROKEN;
  return `Slack said ${err.code} to your own token, so Hearth couldn't look.`;
}

/** The links you wrote in your shared answers: the only ones a member's answer may carry. */
async function sharedLinks(db: Db, teamId: string): Promise<Set<string>> {
  const rows = await db
    .select({ body: slackAnswer.body })
    .from(slackAnswer)
    .where(eq(slackAnswer.teamId, teamId));
  return new Set(rows.flatMap((r) => linksIn(r.body)));
}
