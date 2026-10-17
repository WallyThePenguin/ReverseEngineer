// What the screens show of Jarvis's conversations with people in your Slack (D62). You read them,
// read-only: each member's DM and each channel thread Jarvis answered in, with who's in it, how
// far Jarvis goes for them, and whether it's paused. You act on one from there: Reply as Jarvis
// (slack.dm or slack.post_in_channel, your own sends), Ask Jarvis about this (a new conversation
// of yours, since a member's can't hold your turn), their tier or a block (slack.member_set), or a
// pause (slack.conversation_pause). Only you read these: names and words are other people's.
import {
  approval,
  conversation,
  type DbOrTx,
  entity,
  slackChannel,
  slackInbound,
  slackThread,
  slackUser,
} from "@hearth/db";
import { ActionError, type DigestItem, defineAction, type ReadContext } from "@hearth/kernel";
import { and, count, countDistinct, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { REPLY_ACTION } from "../bot/settings.ts";
import { channelName } from "./in-channel.ts";
import { cleanName, notAMember } from "./people.ts";

type ThreadRow = typeof slackThread.$inferSelect;

/** The longest a pause from the screen lasts: a week. */
const PAUSE_MAX_HOURS = 168;

/** One conversation as the screens show it. */
async function about(db: DbOrTx, t: ThreadRow, title: string, lastAt: Date | null) {
  const people = await db
    .selectDistinct({ user: slackUser })
    .from(slackInbound)
    .innerJoin(slackUser, eq(slackUser.id, slackInbound.userId))
    .where(eq(slackInbound.conversationId, t.conversationId));
  const [ch] =
    t.audience === "channel"
      ? await db.select().from(slackChannel).where(eq(slackChannel.id, t.channelId))
      : [];
  const [waiting] = await db
    .select({ n: count() })
    .from(slackInbound)
    .where(and(eq(slackInbound.conversationId, t.conversationId), isNull(slackInbound.takenAt)));
  const [held] = await db
    .select({ n: count() })
    .from(approval)
    .where(
      and(
        eq(approval.conversationId, t.conversationId),
        eq(approval.action, REPLY_ACTION),
        eq(approval.status, "pending"),
      ),
    );
  return {
    id: t.conversationId,
    title,
    lastAt,
    place: t.audience === "channel" ? ("channel" as const) : ("dm" as const),
    channel: ch
      ? {
          id: ch.id,
          name: channelName(ch.name, ch.id),
          tier: ch.jarvisTier,
          replies: ch.jarvisReplies,
        }
      : null,
    // A DM's member first; in a channel's thread, everyone who asked Jarvis there.
    people: people
      .map(({ user: u }) => ({
        id: u.id,
        name: cleanName(u.name, u.id),
        tier: u.tier,
        replies: u.replies,
        vip: u.vip,
        notAMember: notAMember(u),
        member: u.principal === t.member,
      }))
      .sort((a, b) => Number(b.member) - Number(a.member)),
    threadTs: t.threadTs || null,
    pausedUntil: t.pausedUntil,
    waiting: waiting?.n ?? 0,
    heldReplies: held?.n ?? 0,
  };
}

async function threadOf(db: DbOrTx, id: string) {
  const [row] = await db
    .select({ thread: slackThread, title: entity.title, lastAt: conversation.lastTurnAt })
    .from(slackThread)
    .innerJoin(entity, eq(entity.id, slackThread.conversationId))
    .innerJoin(conversation, eq(conversation.entityId, slackThread.conversationId))
    .where(
      and(
        eq(slackThread.conversationId, id),
        inArray(slackThread.audience, ["member", "channel"]),
        isNull(entity.deletedAt),
      ),
    );
  if (!row) throw new ActionError("not_found", "That isn't a conversation with someone in Slack.");
  return row;
}

const id = z.string().uuid();

export const conversationActions = [
  defineAction({
    name: "slack.conversations",
    description:
      "The Jarvis bot's conversations with people in your Slack, most recent first: each member's DM and each channel thread it answered in.",
    input: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
    risk: "read",
    // Their names and words: the screens are the only reader.
    callers: ["owner"],
    async handler(i, ctx) {
      const rows = await ctx.tx
        .select({ thread: slackThread, title: entity.title, lastAt: conversation.lastTurnAt })
        .from(slackThread)
        .innerJoin(entity, eq(entity.id, slackThread.conversationId))
        .innerJoin(conversation, eq(conversation.entityId, slackThread.conversationId))
        .where(and(inArray(slackThread.audience, ["member", "channel"]), isNull(entity.deletedAt)))
        .orderBy(desc(sql`coalesce(${conversation.lastTurnAt}, ${slackThread.createdAt})`))
        .limit(i.limit);
      const out = [];
      for (const r of rows) out.push(await about(ctx.tx, r.thread, r.title, r.lastAt));
      return out;
    },
  }),
  defineAction({
    name: "slack.conversation",
    description:
      "Who one of the Jarvis bot's Slack conversations is with, where, and whether it's paused.",
    input: z.object({ id }),
    risk: "read",
    callers: ["owner"],
    async handler(i, ctx) {
      const r = await threadOf(ctx.tx, i.id);
      return about(ctx.tx, r.thread, r.title, r.lastAt);
    },
  }),
  defineAction({
    name: "slack.conversation_pause",
    description:
      "Pause the Jarvis bot in one of its Slack conversations for some hours, so what's written there is passed on to you instead, or resume it (0 hours).",
    input: z.object({ id, hours: z.number().int().min(0).max(PAUSE_MAX_HOURS) }),
    risk: "internal",
    // Only you: a pause is how you take a conversation over (D62).
    callers: ["owner"],
    async handler(i, ctx) {
      const r = await threadOf(ctx.tx, i.id);
      const until = i.hours ? new Date(ctx.now.getTime() + i.hours * 3_600_000) : null;
      await ctx.tx
        .update(slackThread)
        .set({ pausedUntil: until })
        .where(eq(slackThread.conversationId, r.thread.conversationId));
      return { id: i.id, pausedUntil: until };
    },
  }),
];

/**
 * The brief's line about Slack (D62): how many messages Jarvis answered, from how many people.
 * It counts what other people wrote, so it's marked outside.
 */
export async function memberDigest(ctx: ReadContext & { since: Date }): Promise<DigestItem[]> {
  const [row] = await ctx.db
    .select({ messages: count(), people: countDistinct(slackInbound.userId) })
    .from(slackInbound)
    .where(
      and(
        eq(slackInbound.outcome, "answered"),
        gte(slackInbound.takenAt, ctx.since),
        // Your own @mentions in a channel aren't someone writing to you.
        sql`${slackInbound.userId} <> coalesce((SELECT user_id FROM slack_workspace LIMIT 1), '')`,
      ),
    );
  const n = row?.messages ?? 0;
  if (!n) return [];
  const p = row?.people ?? 0;
  const text = `The Jarvis bot answered ${n} Slack message${n === 1 ? "" : "s"} from ${p} ${p === 1 ? "person" : "people"}.`;
  return [{ bucket: "handled", text, outside: true }];
}
