// Catching up (D62). When Hearth is off, Slack keeps nothing: a message to Jarvis while the PC
// sleeps or restarts was sent over a socket nobody held. So on every hello, and every 10 minutes
// while connected, the worker reads back what it may have missed and stores it like anything the
// socket heard (inbound.ts), once per message however it arrives. This also recovers events
// that a second connection took.
//
// - The bot's DMs, with its own token: your token can't see them. Each is read from its mark (the
//   DM's slack_thread row, once Jarvis has a conversation there) or from where listening started.
// - @Jarvis in channels that are on, with your token's search, which finds thread replies too.
//   The bot has no channel history scope, so a leaked bot token can't read every channel it's in.
//
// Marks move only past what was read, so a round cut short reads the rest next time. The first
// connect starts at now: nothing said before it is imported.
import { type DbOrTx, slackBot, slackChannel, slackThread, slackWorkspace } from "@hearth/db";
import type { ActionContext } from "@hearth/kernel";
import { and, eq, isNull, ne } from "drizzle-orm";
import { SEARCH_PAGE, SlackError, type SlackMatch } from "../api.ts";
import { later, openToken, slackApi, tsCompare } from "../save.ts";
import type { SlackBotApi } from "./api.ts";
import { REVOKED_CODES } from "./health.ts";
import { storeInbound } from "./inbound.ts";
import { counts, type Heard, inboundRow, type Ours, slackTs } from "./socket.ts";
import { type BotRow, botApi, openBotToken } from "./tokens.ts";

export const CATCH_UP_EVERY_MS = 10 * 60_000;
/** A DM page, and how many pages of one DM a round reads; past that its mark waits. */
const DM_PAGE = 200;
const DM_PAGES = 10;
/** Pages of search a round reads; more @Jarvis than that since the mark waits a round. */
const SEARCH_PAGES = 5;
/** A DM Slack says is gone or archived: nothing to read there, and nothing wrong. */
const GONE: ReadonlySet<string> = new Set(["channel_not_found", "is_archived", "not_in_channel"]);

type Services = Pick<ActionContext, "service">;

export interface CatchUp {
  /** The first connect: listening starts now, and nothing earlier was read. */
  first: boolean;
  /** New messages stored from the bot's DMs, and from @Jarvis in channels. */
  dms: number;
  mentions: number;
  /** What couldn't be read this round; its marks didn't move. */
  errors: string[];
}

const said = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The bot's token stopped working: the socket's owner stops, rather than this carrying on. */
function rethrowIfRevoked(err: unknown) {
  if (err instanceof SlackError && REVOKED_CODES.has(err.code)) throw err;
}

/** One DM from `oldest`, newest first. Complete when every page was read. */
async function readDm(api: SlackBotApi, token: string, channel: string, oldest: string) {
  const messages: Heard[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < DM_PAGES; page++) {
    const got = await api.history(token, channel, { oldest, cursor, limit: DM_PAGE });
    messages.push(...got.messages);
    cursor = got.next;
    if (!cursor) return { messages, complete: true };
  }
  return { messages, complete: false };
}

async function catchUpDms(
  db: DbOrTx,
  services: Services,
  bot: BotRow,
  ours: Ours,
  now: Date,
  errors: string[],
): Promise<number> {
  const token = openBotToken(services, bot, "bot");
  const api = botApi(services);
  const threads = await db
    .select({ channelId: slackThread.channelId, mark: slackThread.mark })
    .from(slackThread)
    .where(and(eq(slackThread.teamId, bot.teamId), eq(slackThread.threadTs, "")));
  const marks = new Map(threads.map((t) => [t.channelId, t.mark]));
  let ims: { id: string; user: string }[];
  try {
    ims = await api.ims(token);
  } catch (err) {
    rethrowIfRevoked(err);
    errors.push(`The bot's DMs: ${said(err)}`);
    return 0;
  }
  let stored = 0;
  for (const im of ims) {
    if (im.user === "USLACKBOT") continue;
    const mark = marks.get(im.id);
    const oldest = later(bot.listenFrom, mark) ?? (bot.listenFrom as string);
    let read: Awaited<ReturnType<typeof readDm>>;
    try {
      read = await readDm(api, token, im.id, oldest);
    } catch (err) {
      rethrowIfRevoked(err);
      if (err instanceof SlackError && GONE.has(err.code)) continue;
      errors.push(`The DM ${im.id}: ${said(err)}`);
      // Slack asked Hearth to slow down: the rest wait for the next round.
      if (err instanceof SlackError && err.code === "ratelimited") break;
      continue;
    }
    const rows = read.messages
      .filter((m) => counts(m, ours))
      .map((m) => inboundRow(m, bot.teamId, "catchup", now, { channelType: "im" }));
    stored += await storeInbound(db, rows);
    // Past everything read here, Jarvis's own replies included; only once the DM has a
    // conversation to hold the mark (the take loop makes it).
    const newest = read.messages.reduce<string | null>((n, m) => later(n, m.ts), mark ?? null);
    if (read.complete && marks.has(im.id) && newest && newest !== mark)
      await db
        .update(slackThread)
        .set({ mark: newest })
        .where(and(eq(slackThread.channelId, im.id), eq(slackThread.threadTs, "")));
  }
  return stored;
}

const heardOfMatch = (m: SlackMatch): Heard => ({
  channel: m.channel,
  ts: m.ts,
  user: m.user,
  botId: m.botId,
  subtype: m.subtype,
  text: m.text,
  threadTs: m.threadTs,
  teams: [],
});

async function catchUpMentions(
  db: DbOrTx,
  services: Services,
  bot: BotRow,
  ours: Ours,
  now: Date,
  errors: string[],
): Promise<number> {
  const mark = (bot.mentionsTs ?? bot.listenFrom) as string;
  const setMark = async (ts: string) => {
    if (ts !== mark)
      await db.update(slackBot).set({ mentionsTs: ts }).where(eq(slackBot.teamId, bot.teamId));
  };
  const on = await db
    .select({ id: slackChannel.id, kind: slackChannel.kind })
    .from(slackChannel)
    .where(and(eq(slackChannel.teamId, bot.teamId), ne(slackChannel.jarvisTier, "off")));
  // With no channel on there's nothing to read, so everything up to now has been: a channel turned
  // on later is caught up from then, not from what was said while it was off.
  if (!on.length) {
    await setMark(later(mark, slackTs(now)) ?? mark);
    return 0;
  }
  const [ws] = await db.select().from(slackWorkspace).where(eq(slackWorkspace.teamId, bot.teamId));
  if (!ws || ws.syncState === "revoked") {
    errors.push("Your own Slack token isn't working, so @Jarvis in channels wasn't read back.");
    return 0;
  }
  const kinds = new Map(on.map((c) => [c.id, c.kind]));
  const read: SlackMatch[] = [];
  let complete = false;
  try {
    const token = openToken(services, ws);
    for (let page = 1; page <= SEARCH_PAGES && !complete; page++) {
      const matches = await slackApi(services).mentions(token, bot.botUserId, page);
      read.push(...matches);
      complete = matches.length < SEARCH_PAGE || matches.some((m) => tsCompare(m.ts, mark) <= 0);
    }
  } catch (err) {
    // Your token's own troubles are the poller's to report (D61); the mark waits.
    errors.push(`@Jarvis in channels: ${said(err)}`);
    complete = false;
  }
  const fresh = read.filter((m) => tsCompare(m.ts, mark) > 0);
  const rows = fresh
    .filter((m) => kinds.has(m.channel))
    .map(heardOfMatch)
    .filter((m) => counts(m, ours))
    .map((m) =>
      inboundRow(m, bot.teamId, "catchup", now, { channelType: kinds.get(m.channel) as string }),
    );
  const stored = await storeInbound(db, rows);
  if (complete) await setMark(fresh.reduce<string>((n, m) => later(n, m.ts) ?? n, mark));
  return stored;
}

/**
 * One round of catching up for the bot in `teamId`. Throws a SlackError when the bot's token was
 * revoked, for the socket's owner to stop on; anything else is in `errors`.
 */
export async function catchUp(
  db: DbOrTx,
  services: Services,
  teamId: string,
  now: Date,
): Promise<CatchUp> {
  const done: CatchUp = { first: false, dms: 0, mentions: 0, errors: [] };
  const [bot] = await db.select().from(slackBot).where(eq(slackBot.teamId, teamId));
  if (!bot) return done;
  if (!bot.listenFrom) {
    const at = slackTs(now);
    await db
      .update(slackBot)
      .set({ listenFrom: at, mentionsTs: at })
      .where(and(eq(slackBot.teamId, teamId), isNull(slackBot.listenFrom)));
    return { ...done, first: true };
  }
  const ours: Ours = { appId: bot.appId, teamId, botUserId: bot.botUserId };
  done.dms = await catchUpDms(db, services, bot, ours, now, done.errors);
  done.mentions = await catchUpMentions(db, services, bot, ours, now, done.errors);
  return done;
}
