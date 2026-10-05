// What happens to a member's waiting messages (D62): a turn, or a relay to you with a fixed note.
// At most one turn waits per member in a conversation, and it folds in everything they wrote
// before it runs, so a burst of messages is one turn. No turn when:
// - the conversation or Jarvis is paused (and 20 of Jarvis's posts in one conversation within ten
//   minutes pause it for an hour, and tell you: the loop breaker);
// - Jarvis hasn't got to a message in ten minutes (it's down, or busy with you);
// - more than ten are already waiting on the turn to come;
// - the member is over their budget (4 turns in ten minutes, 20 a day), all members together are
//   over theirs (60 a day, apart from the proactive budget), or Claude's usage limit was hit in
//   the last quarter of an hour: member turns stop first, so yours still run.
import { startOfLocalDay } from "@hearth/core";
import { jarvisTurn, slackOutbox, slackThread } from "@hearth/db";
import { type ActionContext, createNotification, getSetting, newId } from "@hearth/kernel";
import { and, count, eq, gt, gte, inArray, sql } from "drizzle-orm";
import { type InboundRow, relayRows, WAIT_MS, type Writer } from "./messages.ts";
import type { ThreadRow } from "./people.ts";

/** The most messages that wait on one turn; past that they're passed on (D62). */
export const MAX_WAITING = 10;
/** The loop breaker: this many of Jarvis's posts in a conversation within ten minutes. */
export const LOOP_POSTS = 20;
const LOOP_WINDOW_MS = 10 * 60_000;
const LOOP_PAUSE_MS = 3_600_000;
/** Member turns stop for this long after Claude's usage limit is hit. */
const LIMIT_COOL_MS = 15 * 60_000;

/** Turns that count against a budget: ones that ran or will. */
const COUNTED = ["queued", "running", "done", "failed"] as const;

/** The member it's for, their conversation and its place in Slack. */
export interface Conversation {
  who: Writer & { user: string };
  thread: ThreadRow;
}

/** The loop breaker: pauses a conversation Jarvis has been posting in too much, and tells you. */
async function looping(ctx: ActionContext, c: Conversation): Promise<boolean> {
  const since = new Date(ctx.now.getTime() - LOOP_WINDOW_MS);
  const [posts] = await ctx.tx
    .select({ n: count() })
    .from(slackOutbox)
    .where(
      and(
        eq(slackOutbox.conversationId, c.thread.conversationId),
        gt(slackOutbox.createdAt, since),
      ),
    );
  if ((posts?.n ?? 0) < LOOP_POSTS) return false;
  const until = new Date(ctx.now.getTime() + LOOP_PAUSE_MS);
  await ctx.tx
    .update(slackThread)
    .set({ pausedUntil: until })
    .where(eq(slackThread.conversationId, c.thread.conversationId));
  c.thread = { ...c.thread, pausedUntil: until };
  await createNotification(ctx, {
    kind: "slack.loop",
    title: `Jarvis paused its Slack conversation with ${c.who.name} for an hour`,
    body: `It posted there ${LOOP_POSTS} times in ten minutes, which looks like a loop. Their messages are passed on to you meanwhile.`,
    entityId: c.thread.conversationId,
    lane: "signal",
    dedupeKey: `slack.loop:${c.thread.conversationId}:${until.toISOString().slice(0, 13)}`,
  });
  return true;
}

/** Whether no turn may start for this member now: a budget is spent, or Claude's limit was hit. */
async function overBudget(ctx: ActionContext, principal: string) {
  const budget = await getSetting(ctx.tx, "slack.bot.memberTurns");
  const { timeZone } = await getSetting(ctx.tx, "owner.dayRules");
  const today = startOfLocalDay(ctx.now, timeZone);
  const member = sql`${jarvisTurn.context}->>'member' = ${principal}`;
  const counted = and(
    eq(jarvisTurn.trigger, "slack_member"),
    inArray(jarvisTurn.status, [...COUNTED]),
  );
  const n = async (...where: Parameters<typeof and>) => {
    const [row] = await ctx.tx
      .select({ n: count() })
      .from(jarvisTurn)
      .where(and(counted, ...where));
    return row?.n ?? 0;
  };
  const [limited] = await ctx.tx
    .select({ id: jarvisTurn.id })
    .from(jarvisTurn)
    .where(
      and(
        eq(jarvisTurn.errorKind, "rate_limit"),
        gt(jarvisTurn.finishedAt, new Date(ctx.now.getTime() - LIMIT_COOL_MS)),
      ),
    )
    .limit(1);
  if (limited) return true;
  if (
    (await n(gt(jarvisTurn.queuedAt, new Date(ctx.now.getTime() - 10 * 60_000)), member)) >=
    budget.perTenMinutes
  )
    return true;
  if ((await n(gte(jarvisTurn.queuedAt, today), member)) >= budget.perDay) return true;
  return (await n(gte(jarvisTurn.queuedAt, today))) >= budget.allPerDay;
}

/** What became of a conversation's waiting messages this round. */
export type Decision = "turn" | "waiting" | "relayed" | "busy";

/**
 * What else a turn needs before it's queued, like the thread a channel turn answers in; null
 * when it can't be had yet, and the messages wait a round.
 */
export type More = () => Promise<Record<string, unknown> | null>;

/**
 * Decides for one member's waiting messages in a conversation (oldest first): starts their turn,
 * leaves them to the turn already waiting, or passes them on to you. In a channel's thread each
 * member who wrote gets a turn of their own, so who is answered is never in doubt (D62).
 */
export async function decide(
  ctx: ActionContext,
  c: Conversation,
  waiting: InboundRow[],
  more?: More,
): Promise<Decision> {
  if (!waiting.length) return "waiting";
  const { who, thread } = c;
  if (
    (thread.pausedUntil && thread.pausedUntil > ctx.now) ||
    (await getSetting(ctx.tx, "jarvis.paused")) ||
    (await looping(ctx, c))
  ) {
    await relayRows(ctx, who, waiting, "paused");
    return "relayed";
  }
  const [queued] = await ctx.tx
    .select({ id: jarvisTurn.id })
    .from(jarvisTurn)
    .where(
      and(
        eq(jarvisTurn.conversationId, thread.conversationId),
        eq(jarvisTurn.trigger, "slack_member"),
        eq(jarvisTurn.status, "queued"),
        sql`${jarvisTurn.context}->>'member' = ${who.principal}`,
      ),
    )
    .for("update");
  const oldest = waiting[0]!;
  if (oldest.receivedAt.getTime() <= ctx.now.getTime() - WAIT_MS) {
    // Jarvis hasn't got to it: the turn waiting is let go, unless it has just started.
    if (queued) {
      const let_go = await ctx.tx
        .update(jarvisTurn)
        .set({
          status: "skipped",
          skipReason: "expired",
          errorKind: "expired",
          finishedAt: ctx.now,
        })
        .where(and(eq(jarvisTurn.id, queued.id), eq(jarvisTurn.status, "queued")))
        .returning({ id: jarvisTurn.id });
      if (!let_go.length) return "waiting";
    }
    await relayRows(ctx, who, waiting, "sorry");
    return "relayed";
  }
  if (queued) {
    if (waiting.length <= MAX_WAITING) return "waiting";
    await relayRows(ctx, who, waiting.slice(MAX_WAITING), "busy");
    return "busy";
  }
  if (await overBudget(ctx, who.principal)) {
    await relayRows(ctx, who, waiting, "busy");
    return "busy";
  }
  const extra = more ? await more() : {};
  if (!extra) return "waiting";
  await ctx.tx.insert(jarvisTurn).values({
    id: newId(),
    trigger: "slack_member",
    mode: "reactive",
    lane: "fast",
    // A member's words are outside content: their turn runs as them, never with your rights.
    origin: "untrusted",
    prompt: `Slack messages from ${who.name}`,
    context: {
      member: who.principal,
      team: who.teamId,
      user: who.user,
      channel: thread.channelId,
      // Ten minutes from the first message it answers (TURN_TTL_MS.slack_member).
      askedAt: oldest.receivedAt.toISOString(),
      ...extra,
    },
    conversationId: thread.conversationId,
    queuedAt: ctx.now,
    notBefore: ctx.now,
  });
  return "turn";
}
