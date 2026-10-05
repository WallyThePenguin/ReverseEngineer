// Reading Slack in page by page (D61): a channel's new messages, newest first, and the replies in
// its threads. A round reads only so much, and what's left waits for the next one; a channel's
// mark only moves past what has been read, so nothing in between is skipped.
import { slackChannel, slackMessage } from "@hearth/db";
import { type ActionContext, savepoint } from "@hearth/kernel";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import type { Trouble } from "../connector-health.ts";
import { SlackError, type SlackMessage } from "./api.ts";
import {
  type ChannelRow,
  later,
  noteReplies,
  saveMessage,
  slackApi,
  tsCompare,
  type WorkspaceRow,
} from "./save.ts";

/** Messages asked for per page, and pages one channel or thread may read in a round. */
export const PAGE = 200;
export const PAGES_PER_READ = 5;
/** Slack calls a round may spend on channels and threads: Slack allows about 50 a minute. */
export const CALLS_PER_SYNC = 40;
/** Threads read per round. */
export const THREADS_PER_SYNC = 10;
/** How far back a channel is looked over for new replies, and how often. */
const THREAD_WATCH_S = 3 * 86_400;
const THREAD_SCAN_MS = 10 * 60_000;
/** A channel that's gone, or that you left: it stops being read in, quietly. */
const CHANNEL_GONE = new Set(["channel_not_found", "not_in_channel", "is_archived"]);
/** Slack's own trouble, which passes by itself. */
export const PASSING =
  /^(http_5\d\d|internal_error|fatal_error|service_unavailable|request_timeout)$/;

/** Trouble with one channel or thread only, which the rest of the round can go on past. */
export const onlyThis = (err: unknown): err is SlackError =>
  err instanceof SlackError && !err.revoked && err.code !== "ratelimited";

/**
 * Notes that a channel (or a thread in it) couldn't be read. A channel that's gone is no longer
 * read in; anything else is a trouble for the round to tell. `polled`: the channel's own messages
 * were asked for, so it waits behind the others next round.
 */
export async function setAside(
  ctx: ActionContext,
  channel: ChannelRow,
  err: SlackError,
  troubles: Trouble[],
  polled: boolean,
) {
  const gone = CHANNEL_GONE.has(err.code);
  if (!gone)
    troubles.push({
      // Slack's own hiccup on one channel is told only if it keeps on, like any other.
      kind: PASSING.test(err.code) ? "transient" : "refused",
      message: `#${channel.name}: ${err.message}`,
    });
  if (gone || polled)
    await ctx.tx
      .update(slackChannel)
      .set({ ...(polled ? { polledAt: ctx.now } : {}), ...(gone ? { ingest: false } : {}) })
      .where(eq(slackChannel.id, channel.id));
}

export interface Budget {
  calls: number;
}

/**
 * Reads a channel's new messages. When more came in than a round reads, the newest are read
 * first and the older rest in later rounds (between last_ts and backlog_ts), quietly.
 */
export async function readChannel(
  ctx: ActionContext,
  ws: WorkspaceRow,
  token: string,
  channel: ChannelRow,
  floor: string,
  budget: Budget,
  settled: boolean,
): Promise<number> {
  const api = slackApi(ctx);
  const got: SlackMessage[] = [];
  let cursor: string | undefined;
  let done = false;
  for (let page = 0; page < PAGES_PER_READ && budget.calls > 0; page++) {
    budget.calls--;
    const r = await api.history(token, channel.id, {
      oldest: floor,
      latest: channel.backlogTs ?? undefined,
      cursor,
      limit: PAGE,
    });
    got.push(...r.messages);
    cursor = r.next;
    if (!cursor) {
      done = true;
      break;
    }
  }
  // Oldest first, so a reply finds the start of its thread.
  got.sort((a, b) => tsCompare(a.ts, b.ts));
  // A first look, and what's left from a busy spell, come in quietly.
  const announce = settled && channel.lastTs !== null && channel.backlogTs === null;
  let added = 0;
  for (const m of got) if (await saveMessage(ctx, ws, token, channel, m, { announce })) added++;
  const top = channel.backlogTop ?? got.at(-1)?.ts ?? null;
  let threadsAt = channel.threadsAt;
  if (done && channel.lastTs === null) threadsAt = ctx.now;
  else if (done && budget.calls > 0 && scanDue(ctx, channel)) {
    budget.calls--;
    await scanThreads(ctx, token, channel);
    threadsAt = ctx.now;
  }
  await ctx.tx
    .update(slackChannel)
    .set(
      done
        ? { lastTs: top ?? floor, backlogTs: null, backlogTop: null, polledAt: ctx.now, threadsAt }
        : {
            lastTs: floor,
            backlogTs: got[0]?.ts ?? channel.backlogTs,
            backlogTop: top,
            polledAt: ctx.now,
          },
    )
    .where(eq(slackChannel.id, channel.id));
  return added;
}

const scanDue = (ctx: ActionContext, c: ChannelRow) =>
  !c.threadsAt || ctx.now.getTime() - c.threadsAt.getTime() >= THREAD_SCAN_MS;

/**
 * A reply doesn't bring its thread's start back into the channel's history, so the last few
 * days of it are looked over now and then for threads with replies Hearth hasn't read.
 */
async function scanThreads(ctx: ActionContext, token: string, channel: ChannelRow) {
  const oldest = String(Math.floor(ctx.now.getTime() / 1000) - THREAD_WATCH_S);
  const r = await slackApi(ctx).history(token, channel.id, { oldest, limit: PAGE });
  for (const m of r.messages)
    if (m.latestReply) await noteReplies(ctx, channel.id, m.ts, m.latestReply);
}

/**
 * Reads the replies Hearth hasn't, in threads it knows have some, least recently read first. A
 * thread that can't be read waits behind the others, so it never holds them up.
 */
export async function readThreads(
  ctx: ActionContext,
  ws: WorkspaceRow,
  token: string,
  budget: Budget,
  settled: boolean,
  troubles: Trouble[],
): Promise<number> {
  const due = await ctx.tx
    .select({ m: slackMessage, channel: slackChannel })
    .from(slackMessage)
    .innerJoin(slackChannel, eq(slackChannel.id, slackMessage.channelId))
    .where(
      and(
        eq(slackChannel.teamId, ws.teamId),
        eq(slackChannel.ingest, true),
        isNotNull(slackMessage.latestReply),
        sql`${slackMessage.latestReply}::numeric > coalesce(${slackMessage.repliesRead}, ${slackMessage.ts})::numeric`,
      ),
    )
    .orderBy(sql`${slackMessage.repliesAt} ASC NULLS FIRST`, asc(slackMessage.sentAt))
    .limit(THREADS_PER_SYNC);
  let added = 0;
  const failed = new Set<string>();
  for (const { m, channel } of due) {
    if (budget.calls <= 0) break;
    // The channel's other threads would fail the same way this round.
    if (failed.has(channel.id)) continue;
    try {
      added += await savepoint(ctx, (sp) => readThread(sp, ws, token, channel, m, budget, settled));
    } catch (err) {
      if (!onlyThis(err)) throw err;
      failed.add(channel.id);
      await ctx.tx
        .update(slackMessage)
        .set({ repliesAt: ctx.now })
        .where(eq(slackMessage.entityId, m.entityId));
      await setAside(ctx, channel, err, troubles, false);
    }
  }
  return added;
}

async function readThread(
  ctx: ActionContext,
  ws: WorkspaceRow,
  token: string,
  channel: ChannelRow,
  start: typeof slackMessage.$inferSelect,
  budget: Budget,
  settled: boolean,
): Promise<number> {
  let newest: string | null = null;
  let cursor: string | undefined;
  let done = false;
  let added = 0;
  try {
    for (let page = 0; page < PAGES_PER_READ && budget.calls > 0; page++) {
      budget.calls--;
      const r = await slackApi(ctx).replies(token, channel.id, start.ts, {
        oldest: start.repliesRead ?? start.ts,
        cursor,
        limit: PAGE,
      });
      for (const reply of r.messages) {
        const m = { ...reply, threadTs: start.ts };
        if (await saveMessage(ctx, ws, token, channel, m, { announce: settled })) added++;
        newest = later(newest, reply.ts);
      }
      cursor = r.next;
      if (!cursor) {
        done = true;
        break;
      }
    }
  } catch (err) {
    // The thread's start was deleted: there's nothing more to read in it.
    if (!(err instanceof SlackError && err.code === "thread_not_found")) throw err;
    await ctx.tx
      .update(slackMessage)
      .set({ latestReply: null, repliesAt: ctx.now })
      .where(eq(slackMessage.entityId, start.entityId));
    return added;
  }
  const read = later(start.repliesRead, newest);
  await ctx.tx
    .update(slackMessage)
    .set({
      repliesRead: done ? later(read, start.latestReply) : read,
      latestReply: later(start.latestReply, newest),
      repliesAt: ctx.now,
    })
    .where(eq(slackMessage.entityId, start.entityId));
  return added;
}
