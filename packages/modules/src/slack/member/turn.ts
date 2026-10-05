// What a member's turn reads before it runs (D62), for the Jarvis runner (packages/jarvis/src/
// member-turn.ts): whether it may run at all, the messages it answers, and the little it knows.
// A member turn knows only what the owner wrote down to share with them, and what the owner had
// Jarvis send them: never memory, a record, another conversation or anything Jarvis reads for you.
import {
  type Db,
  type DbOrTx,
  slackAnswer,
  slackBot,
  slackChannel,
  slackInbound,
  slackOutbox,
  slackUser,
  slackWorkspace,
} from "@hearth/db";
import { getSetting } from "@hearth/kernel";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { channelName } from "./in-channel.ts";
import type { InboundRow } from "./messages.ts";
import { cleanName, type MemberNow, memberNow, reaches } from "./people.ts";

/** At most this many messages, and this many characters, fold into one turn (D62). */
export const FOLD_MESSAGES = 10;
export const FOLD_CHARS = 12_000;
/** The answers you've shared take at most this much of a member's prompt. */
export const ANSWERS_MAX = 4096;
/** The last few things you had Jarvis send them, so their answer has context. */
const SENT_SHOWN = 5;

export interface TurnLike {
  id: string;
  conversationId: string | null;
  context: Record<string, unknown>;
}

/**
 * Whether a member's turn may run now (D62): members on and the bot connected, the member not
 * blocked, still a full member, and Jarvis and their conversation not paused. Checked again
 * when the turn starts, whatever was true when it was queued.
 */
export async function memberGate(
  db: Db,
  turn: TurnLike,
  now: Date,
): Promise<{ ok: true; member: MemberNow; teamId: string } | { ok: false; why: string }> {
  const principal = String(turn.context.member ?? "");
  if (!turn.conversationId || !principal) return { ok: false, why: "not_a_member_turn" };
  if (!(await getSetting(db, "slack.bot.membersOn"))) return { ok: false, why: "members_off" };
  const [bot] = await db.select({ teamId: slackBot.teamId }).from(slackBot).limit(1);
  if (!bot) return { ok: false, why: "no_bot" };
  const member = await memberNow(db, {
    kind: "member",
    principal,
    conversationId: turn.conversationId,
  });
  if (!member?.thread) return { ok: false, why: "not_a_member" };
  if (!reaches(member.tier, "relay")) return { ok: false, why: "blocked" };
  if (member.thread.pausedUntil && member.thread.pausedUntil > now)
    return { ok: false, why: "paused" };
  if (await getSetting(db, "jarvis.paused")) return { ok: false, why: "paused" };
  return { ok: true, member, teamId: bot.teamId };
}

/**
 * Folds the messages its member has waiting in a turn's conversation into it, oldest first, in
 * one UPDATE … RETURNING: up to ten and 12,000 characters (the first always). In a channel's
 * thread others' messages wait for their own turns. A turn run again after a crash gets the ones
 * it had back. None means there's nothing to answer, and the turn is skipped.
 */
export async function claimMessages(
  db: Db,
  turnId: string,
  conversationId: string,
  user: string,
): Promise<InboundRow[]> {
  const mine = sql`(s.turn_id = ${turnId} AND s.outcome = 'claimed')
    OR (s.turn_id IS NULL AND s.outcome = 'waiting' AND s.user_id = ${user})`;
  const res = await db.execute<{ ts: string }>(sql`
    WITH pick AS (
      SELECT channel_id, ts FROM (
        SELECT s.channel_id, s.ts,
          row_number() OVER (ORDER BY s.ts::numeric) AS n,
          sum(char_length(coalesce(s.text, ''))) OVER (ORDER BY s.ts::numeric) AS chars
        FROM slack_inbound s
        WHERE s.conversation_id = ${conversationId} AND s.taken_at IS NULL AND (${mine})
      ) w
      WHERE n <= ${FOLD_MESSAGES} AND (n = 1 OR chars <= ${FOLD_CHARS})
    )
    UPDATE slack_inbound s SET turn_id = ${turnId}, outcome = 'claimed'
    FROM pick
    WHERE s.channel_id = pick.channel_id AND s.ts = pick.ts AND s.taken_at IS NULL AND (${mine})
    RETURNING s.ts`);
  const keys = res.rows.map((r) => r.ts);
  if (!keys.length) return [];
  return db
    .select()
    .from(slackInbound)
    .where(and(eq(slackInbound.turnId, turnId), inArray(slackInbound.ts, keys)))
    .orderBy(asc(sql`${slackInbound.ts}::numeric`));
}

/** What a member's prompt holds (prompts/member.ts). */
export interface MemberBrief {
  name: string;
  tier: MemberNow["tier"];
  /** The answers you've shared with them (with everyone in a channel), at most 4 KB. */
  answers: string[];
  /** What you had Jarvis send them lately, oldest first. */
  sent: string[];
  owner: string;
  workspace: string;
  /** The channel whose thread it answers in, which reads the answer; null in their DM. */
  channel: string | null;
  /** Whether it's you, @mentioning Jarvis in a channel: still answered as the channel's. */
  ownerAsking: boolean;
}

/** The answers a member may be given: for everyone, or naming them in their DM. */
async function sharedWith(db: DbOrTx, teamId: string, user: string, dm: boolean) {
  const rows = await db
    .select({ title: slackAnswer.title, body: slackAnswer.body })
    .from(slackAnswer)
    .where(
      and(
        eq(slackAnswer.teamId, teamId),
        dm
          ? or(sql`${slackAnswer.users} IS NULL`, sql`${user} = ANY(${slackAnswer.users})`)
          : sql`${slackAnswer.users} IS NULL`,
      ),
    )
    .orderBy(asc(slackAnswer.createdAt));
  const out: string[] = [];
  let left = ANSWERS_MAX;
  for (const r of rows) {
    const text = r.title ? `${r.title}: ${r.body}` : r.body;
    if (text.length > left) break;
    out.push(text);
    left -= text.length;
  }
  return out;
}

export async function memberBrief(db: Db, m: MemberNow, teamId: string): Promise<MemberBrief> {
  const dm = m.thread?.audience === "member";
  const [ws] = await db.select().from(slackWorkspace).where(eq(slackWorkspace.teamId, teamId));
  const [me] = ws
    ? await db.select({ name: slackUser.name }).from(slackUser).where(eq(slackUser.id, ws.userId))
    : [];
  const places = [m.user.id, ...(m.thread && dm ? [m.thread.channelId] : [])];
  const sent = dm
    ? await db
        .select({ text: slackOutbox.text })
        .from(slackOutbox)
        .where(
          and(
            eq(slackOutbox.kind, "send"),
            inArray(slackOutbox.channelId, places),
            inArray(slackOutbox.state, ["queued", "sending", "sent"]),
          ),
        )
        .orderBy(desc(slackOutbox.createdAt))
        .limit(SENT_SHOWN)
    : [];
  const [ch] =
    m.thread && !dm
      ? await db
          .select({ id: slackChannel.id, name: slackChannel.name })
          .from(slackChannel)
          .where(eq(slackChannel.id, m.thread.channelId))
      : [];
  return {
    name: m.name,
    tier: m.tier,
    answers: await sharedWith(db, teamId, m.user.id, dm),
    sent: sent.map((s) => s.text).reverse(),
    owner: cleanName(me?.name, "the owner").split(" ")[0] ?? "the owner",
    workspace: cleanName(ws?.teamName, "your workspace"),
    channel: dm ? null : `#${channelName(ch?.name ?? "", m.thread?.channelId ?? "a channel")}`,
    ownerAsking: Boolean(ws && m.user.id === ws.userId),
  };
}

/** A turn's reply waits for your yes: what it answers is settled as held (your card has it). */
export async function holdMessages(db: Db, turnId: string, now: Date): Promise<void> {
  await db
    .update(slackInbound)
    .set({ outcome: "held", takenAt: now })
    .where(and(eq(slackInbound.turnId, turnId), eq(slackInbound.outcome, "claimed")));
}
