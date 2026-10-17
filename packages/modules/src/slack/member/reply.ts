// A member turn's answer going out (D62). The runner calls slack.reply when the turn ends, filling
// in where it goes from the conversation's slack_thread, never from the model; the model is never
// offered it. The handler holds it to that: the call must come from a member's turn, and the
// channel, thread and member must be that turn's conversation's, or nothing is sent. It writes
// one outbox row keyed answer:<turn>, so a turn run again after a crash can't post twice.
//
// It's outward, so it goes out on its own only with the standing rule you hold for members
// ("Jarvis answers members on its own"), and the runner asks first when the member or the channel
// is on review. A held reply is a card with the exact text; it runs once when you say yes (D58),
// lapses after a day, and a newer held reply in the same conversation replaces it.
import {
  approval,
  type Db,
  type DbOrTx,
  jarvisTurn,
  notification,
  slackChannel,
  slackInbound,
  slackUser,
} from "@hearth/db";
import {
  type ActionContext,
  ActionError,
  appendEvents,
  defineAction,
  type ReadContext,
} from "@hearth/kernel";
import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { POST_MAX } from "../bot/filter.ts";
import { enqueue } from "../bot/queue.ts";
import { postingBot } from "../bot/recipients.ts";
import { REPLY_ACTION } from "../bot/settings.ts";
import { channelName } from "./in-channel.ts";
import { memberNow, reaches } from "./people.ts";

const replySnapshot = z.object({ name: z.string(), place: z.string() });
type ReplySnapshot = z.infer<typeof replySnapshot>;

const input = z.object({
  text: z.string().trim().min(1).max(POST_MAX),
  /** The member it answers. */
  to: z.string().regex(/^[UW][A-Z0-9]{2,40}$/),
  /** Their DM with the bot, or the channel of the thread. */
  channelId: z.string().regex(/^[DCG][A-Z0-9]{2,40}$/),
  threadTs: z
    .string()
    .regex(/^\d{9,11}\.\d{6}$/)
    .optional(),
  snapshot: replySnapshot.optional(),
});
type ReplyInput = z.infer<typeof input>;

/** Who the card says it goes to, and where, as the database has them now. */
async function placeOf(db: ReadContext["db"] | ActionContext["tx"], i: ReplyInput) {
  const [u] = await db
    .select({ name: slackUser.name })
    .from(slackUser)
    .where(eq(slackUser.id, i.to));
  const name = (u?.name ?? i.to).replace(/\s+/g, " ").trim().slice(0, 80);
  if (i.channelId.startsWith("D"))
    return { name, place: `their DM with Jarvis${i.threadTs ? ", in a thread" : ""}` };
  // In a channel, by its name: everyone in it reads the reply, so the card says which (D62).
  const [ch] = await db
    .select({ name: slackChannel.name })
    .from(slackChannel)
    .where(eq(slackChannel.id, i.channelId));
  const place = `a thread in #${channelName(ch?.name ?? "", i.channelId)}, which everyone there reads`;
  return { name, place } satisfies ReplySnapshot;
}

const refuse = (why: string) => new ActionError("forbidden", why);

/** The turn a reply answers, and its place in Slack: refused unless they're this member's. */
async function boundTo(ctx: ActionContext, i: ReplyInput) {
  const { caller } = ctx;
  if (caller.kind !== "member" || !caller.turnId)
    throw refuse("Only a Slack member's own turn answers them.");
  const [turn] = await ctx.tx.select().from(jarvisTurn).where(eq(jarvisTurn.id, caller.turnId));
  if (
    !turn?.conversationId ||
    turn.trigger !== "slack_member" ||
    turn.context.member !== caller.principal
  )
    throw refuse("This reply isn't from this member's turn.");
  const m = await memberNow(ctx.tx, { ...caller, conversationId: turn.conversationId });
  const thread = m?.thread;
  if (!m || !thread) throw refuse("This conversation isn't a Slack conversation.");
  if (!reaches(m.tier, "relay")) throw refuse("The Jarvis bot no longer answers this person.");
  if (thread.channelId !== i.channelId) throw refuse("A reply goes only where it was asked.");
  if (m.user.id !== i.to) throw refuse("A reply goes only to who asked.");
  if (thread.audience === "member") {
    if (thread.member !== caller.principal) throw refuse("A reply goes only to who asked.");
    // In a DM, at the top, or in the thread one of the messages it answers was in.
    if (i.threadTs) {
      const [asked] = await ctx.tx
        .select({ ts: slackInbound.ts })
        .from(slackInbound)
        .where(and(eq(slackInbound.turnId, turn.id), eq(slackInbound.threadTs, i.threadTs)))
        .limit(1);
      if (!asked) throw refuse("A reply goes only where it was asked.");
    }
  } else if (i.threadTs !== thread.threadTs) {
    throw refuse("A reply in a channel goes only in its own thread.");
  }
  return { turn, thread };
}

export const replyAction = defineAction({
  name: REPLY_ACTION,
  description:
    "The Jarvis bot's answer to someone in your Slack, in their DM with it or the thread they asked in. Only their own turn sends it, when it ends.",
  input,
  risk: "outward",
  // Only a member's turn: nothing else answers as Jarvis's bot through here (D62).
  callers: ["member"],
  snapshot: async (i, ctx) => ({ snapshot: await placeOf(ctx.db, i) }),
  summarize: (i: ReplyInput) => {
    const s = i.snapshot;
    // All of it: the card shows exactly what goes out.
    return `Reply as Jarvis to ${s?.name ?? i.to} (${i.to}) in ${s?.place ?? i.channelId}\n\n${i.text}`;
  },
  async handler(i, ctx) {
    const { turn, thread } = await boundTo(ctx, i);
    const now = await placeOf(ctx.tx, i);
    if (i.snapshot && (i.snapshot.name !== now.name || i.snapshot.place !== now.place))
      throw new ActionError("conflict", "Who this goes to changed since you were asked.");
    const { ws } = await postingBot(ctx.tx);
    const { row, created } = await enqueue(ctx, {
      // One answer a turn, however often the turn is run (D62).
      dedupeKey: `answer:${turn.id}`,
      teamId: ws.teamId,
      channelId: thread.channelId,
      threadTs: i.threadTs ?? null,
      text: i.text,
      kind: "answer",
      conversationId: turn.conversationId,
      turnId: turn.id,
    });
    // What it answers is settled: the take loop leaves it be.
    await ctx.tx
      .update(slackInbound)
      .set({ outcome: "answered", takenAt: ctx.now })
      .where(
        and(eq(slackInbound.turnId, turn.id), inArray(slackInbound.outcome, ["claimed", "held"])),
      );
    // An older reply still waiting for your yes would go out after this one: it expires. Last,
    // since that takes the event log's lock, which comes after every other.
    await expireHeldReplies(ctx.tx, thread.conversationId, ctx.caller.principal, ctx.now);
    return { queued: true, id: row.id, ...(created ? {} : { alreadyQueued: true }) };
  },
});

/**
 * A newer held reply replaces the older ones to the same member in its conversation (D62): they
 * expire, with their cards, so you never approve an answer to something the member has since
 * moved on from. In a channel's thread, a reply to someone else there stays.
 */
export async function replaceHeldReplies(
  db: Db,
  conversationId: string,
  keepId: string,
  now: Date,
): Promise<number> {
  const [kept] = await db
    .select({ by: approval.requestedBy })
    .from(approval)
    .where(eq(approval.id, keepId));
  if (!kept) return 0;
  return expireHeldReplies(db, conversationId, kept.by, now, "A newer reply replaced it.", keepId);
}

/**
 * Expires the replies to `by` still waiting for your yes in a conversation, with their cards: a
 * newer one replaced them, or went out on its own, so approving one now would post it after.
 */
export async function expireHeldReplies(
  db: DbOrTx,
  conversationId: string,
  by: string,
  now: Date,
  why = "A newer reply went out instead.",
  keepId?: string,
): Promise<number> {
  return db.transaction(async (tx) => {
    const replaced = await tx
      .update(approval)
      .set({ status: "expired", decidedAt: now, error: why })
      .where(
        and(
          eq(approval.action, REPLY_ACTION),
          eq(approval.conversationId, conversationId),
          eq(approval.requestedBy, by),
          eq(approval.status, "pending"),
          keepId ? ne(approval.id, keepId) : undefined,
        ),
      )
      .returning();
    if (!replaced.length) return 0;
    await tx
      .update(notification)
      .set({ state: "done", updatedAt: now })
      .where(
        and(
          inArray(
            notification.approvalId,
            replaced.map((r) => r.id),
          ),
          ne(notification.state, "done"),
        ),
      );
    for (const row of replaced)
      await appendEvents(
        tx,
        [
          {
            kind: "approval.resolved",
            payload: {
              approvalId: row.id,
              action: row.action,
              decision: "expired",
              requestedBy: row.requestedBy,
              conversationId: row.conversationId,
              turnId: row.turnId,
              error: row.error,
            },
          },
        ],
        { actor: "system", origin: "untrusted", correlationId: row.correlationId, at: now },
      );
    return replaced.length;
  });
}
