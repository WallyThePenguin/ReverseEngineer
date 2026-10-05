// The take loop (D62): what members wrote to Jarvis's bot, taken by the worker every 2 s as the
// Slack integration, one round at a time. The socket only stored it (store, then ack); here, after
// the ack, Hearth works out who wrote it and what happens to it:
// - who: a full member of your workspace, as users.info said (check.ts); guests, bots, people
//   from other orgs and deactivated users are never answered. A member gets their principal
//   (member:slack:<team>:<user>) the first time they write; you blocking them stops here;
// - where: one conversation per member's DM, created tainted and outside (D58), titled
//   "Slack: <name>", with each message logged under its author;
// - what next (decide.ts): their turn, or a relay to you with a fixed note.
// A round also settles the turns that ended (sweep.ts). Messages are taken once settled for
// 1.5 s, in Slack's order, so a burst arrives together. Your DM with Jarvis and channel @mentions
// aren't a member's DM: they're left for their own handling.
import { MEMBER_CONVERSATION, memberPrincipal } from "@hearth/core";
import {
  conversation,
  principal,
  slackBot,
  slackInbound,
  slackThread,
  slackUser,
  slackWorkspace,
} from "@hearth/db";
import { type ActionContext, createEntity, defineAction, getSetting } from "@hearth/kernel";
import { and, eq, isNull, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { appendLog } from "../../chat/log.ts";
import { INBOUND_TEXT_MAX } from "../bot/socket.ts";
import { CHECK_EVERY_MS } from "./check.ts";
import { type Conversation, decide } from "./decide.ts";
import {
  type InboundRow,
  LATE_MS,
  plainOf,
  relayRows,
  settle,
  type Writer,
  writtenAt,
} from "./messages.ts";
import { sendNote } from "./notes.ts";
import { cleanName, notAMember, type SlackUserRow } from "./people.ts";
import { settleClaimed } from "./sweep.ts";

/** A message is taken once it's been stored this long, so a burst is taken together. */
export const SETTLE_MS = 1_500;
/** A message whose writer Slack hasn't told Hearth about in a day is let go. */
const UNCHECKED_MS = 86_400_000;
/** The most messages a round looks at. */
const PER_ROUND = 200;

export interface TakeRound {
  taken: number;
  turns: number;
  relayed: number;
  settled: number;
}

type Ws = typeof slackWorkspace.$inferSelect;

/** The member's DM conversation, made the first time they write; null if it's someone else's. */
async function dmConversation(
  ctx: ActionContext,
  ws: Ws,
  row: InboundRow,
  who: { principal: string; name: string },
) {
  const [had] = await ctx.tx
    .select()
    .from(slackThread)
    .where(and(eq(slackThread.channelId, row.channelId), eq(slackThread.threadTs, "")));
  if (had) return had.member === who.principal && had.audience === "member" ? had : null;
  const title = `Slack: ${who.name}`;
  // Tainted and outside from the start (D58): everything in it is a member's words or about them.
  const e = await createEntity(ctx, { type: "conversation", title, outside: true });
  await ctx.tx.insert(conversation).values({
    entityId: e.id,
    startedVia: MEMBER_CONVERSATION,
    taintedAt: ctx.now,
    taintSource: title,
  });
  const [made] = await ctx.tx
    .insert(slackThread)
    .values({
      channelId: row.channelId,
      threadTs: "",
      teamId: ws.teamId,
      conversationId: e.id,
      audience: "member",
      member: who.principal,
      createdAt: ctx.now,
    })
    .returning();
  return made!;
}

/** Their principal, made or renamed; null when you've blocked them. */
async function principalFor(ctx: ActionContext, ws: Ws, u: SlackUserRow, name: string) {
  const id = memberPrincipal(ws.teamId, u.id);
  const displayName = `${name} on Slack`;
  const [p] = await ctx.tx
    .insert(principal)
    .values({ id, kind: "member", displayName })
    .onConflictDoUpdate({ target: principal.id, set: { displayName } })
    .returning();
  if (u.principal !== id)
    await ctx.tx.update(slackUser).set({ principal: id }).where(eq(slackUser.id, u.id));
  return { id, blocked: Boolean(p?.disabledAt) || u.tier === "blocked" };
}

/** A message taken: the conversation it now waits in for a turn, or null when it's settled. */
type Took = { cid: string | null };
const SETTLED: Took = { cid: null };

/**
 * Takes one new message: who wrote it, their conversation, its line in the log. Null when it
 * isn't taken yet, because Slack hasn't said who wrote it.
 */
async function takeOne(ctx: ActionContext, ws: Ws, row: InboundRow): Promise<Took | null> {
  const [u] = await ctx.tx.select().from(slackUser).where(eq(slackUser.id, row.userId));
  const fresh = u?.checkedAt && u.checkedAt.getTime() > ctx.now.getTime() - CHECK_EVERY_MS;
  if (!u || !fresh) {
    // Waits for users.info (check.ts), but not for ever.
    if (row.receivedAt.getTime() >= ctx.now.getTime() - UNCHECKED_MS) return null;
    await settle(ctx, [row], "ignored:unchecked");
    return SETTLED;
  }
  const why = row.userId === ws.userId ? "owner_elsewhere" : notAMember(u);
  if (why) {
    await settle(ctx, [row], `ignored:${why}`);
    return SETTLED;
  }
  const name = cleanName(u.name, u.id);
  const p = await principalFor(ctx, ws, u, name);
  if (p.blocked) {
    await sendNote(ctx, "blocked", {
      teamId: ws.teamId,
      principal: p.id,
      channelId: row.channelId,
      threadTs: row.threadTs,
    });
    await settle(ctx, [row], "blocked");
    return SETTLED;
  }
  const thread = await dmConversation(ctx, ws, row, { principal: p.id, name });
  if (!thread) {
    await settle(ctx, [row], "ignored:not_their_dm");
    return SETTLED;
  }
  const cid = thread.conversationId;
  const text = await plainOf(ctx.tx, row.text);
  const slack = { channel: row.channelId, ts: row.ts, threadTs: row.threadTs };
  const file = row.subtype === "file_share" ? { file: true } : {};
  const [idx] = await appendLog(
    ctx.tx,
    cid,
    [{ kind: "user_message", payload: { text, by: p.id, name, slack, ...file } }],
    ctx.now,
  );
  ctx.emit({
    kind: "conversation.appended",
    entityId: cid,
    payload: { conversationId: cid, idx, kind: "user_message" },
  });
  await ctx.tx
    .update(slackInbound)
    .set({ conversationId: cid })
    .where(and(eq(slackInbound.channelId, row.channelId), eq(slackInbound.ts, row.ts)));
  const who: Writer = { teamId: ws.teamId, principal: p.id, name, vip: u.vip, conversationId: cid };
  // Too late for an answer, or too long to take in: a note and a relay, no turn.
  if (ctx.now.getTime() - writtenAt(row.ts).getTime() > LATE_MS) {
    await relayRows(ctx, who, [row], "late");
    return SETTLED;
  }
  if ((row.text ?? "").length >= INBOUND_TEXT_MAX) {
    await relayRows(ctx, who, [row], "too_long");
    return SETTLED;
  }
  await ctx.tx
    .update(slackInbound)
    .set({ outcome: "waiting" })
    .where(and(eq(slackInbound.channelId, row.channelId), eq(slackInbound.ts, row.ts)));
  return { cid };
}

/** The member and place of a conversation with waiting or claimed messages. */
async function conversationOf(ctx: ActionContext, ws: Ws, cid: string) {
  const [t] = await ctx.tx
    .select({ thread: slackThread, user: slackUser, disabledAt: principal.disabledAt })
    .from(slackThread)
    .innerJoin(slackUser, eq(slackUser.principal, slackThread.member))
    .innerJoin(principal, eq(principal.id, slackThread.member))
    .where(eq(slackThread.conversationId, cid));
  if (!t) return null;
  const who = {
    teamId: ws.teamId,
    principal: t.thread.member!,
    name: cleanName(t.user.name, t.user.id),
    vip: t.user.vip,
    conversationId: cid,
    user: t.user.id,
  };
  // Blocked since, or no longer a member (the daily check): their waiting messages get no turn.
  const blocked = Boolean(t.disabledAt) || t.user.tier === "blocked" || Boolean(notAMember(t.user));
  return { who, thread: t.thread, blocked } satisfies Conversation & { blocked: boolean };
}

/** One round of the take loop. */
export async function takeRound(ctx: ActionContext): Promise<TakeRound> {
  const done: TakeRound = { taken: 0, turns: 0, relayed: 0, settled: 0 };
  // One round at a time, whichever process runs it.
  await ctx.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('slack_take'))`);
  const [ws] = await ctx.tx.select().from(slackWorkspace).limit(1);
  const [bot] = ws
    ? await ctx.tx.select().from(slackBot).where(eq(slackBot.teamId, ws.teamId))
    : [];
  // The kill switch: with members off, nothing they write is taken.
  if (!ws || !bot || !(await getSetting(ctx.tx, "slack.bot.membersOn"))) return done;
  const rows = await ctx.tx
    .select()
    .from(slackInbound)
    .where(
      and(
        isNull(slackInbound.takenAt),
        eq(slackInbound.teamId, ws.teamId),
        eq(slackInbound.channelType, "im"),
        ne(slackInbound.channelId, bot.ownerIm),
        lte(slackInbound.receivedAt, new Date(ctx.now.getTime() - SETTLE_MS)),
      ),
    )
    .orderBy(sql`${slackInbound.ts}::numeric`)
    .limit(PER_ROUND)
    .for("update", { skipLocked: true });
  const conversations = new Map<string, InboundRow[]>();
  const claimed = new Map<string, InboundRow[]>();
  for (const row of rows) {
    if (row.outcome === "claimed" && row.turnId) {
      claimed.set(row.turnId, [...(claimed.get(row.turnId) ?? []), row]);
      continue;
    }
    let cid = row.outcome === "waiting" ? row.conversationId : null;
    if (row.outcome === null) {
      const took = await takeOne(ctx, ws, row);
      if (!took) continue;
      done.taken++;
      cid = took.cid;
    }
    if (!cid) continue;
    conversations.set(cid, [...(conversations.get(cid) ?? []), { ...row, outcome: "waiting" }]);
  }
  for (const [turnId, mine] of claimed) {
    const c = await conversationOf(ctx, ws, mine[0]!.conversationId!);
    if (!c) continue;
    const how = await settleClaimed(ctx, turnId, mine, c.who, c.thread);
    if (how !== "open") done.settled += mine.length;
  }
  for (const [cid, waiting] of conversations) {
    const c = await conversationOf(ctx, ws, cid);
    if (!c) continue;
    if (c.blocked) {
      const last = waiting.at(-1)!;
      const to = { channelId: last.channelId, threadTs: last.threadTs, conversationId: cid };
      await sendNote(ctx, "blocked", { teamId: ws.teamId, principal: c.who.principal, ...to });
      await settle(ctx, waiting, "blocked");
      continue;
    }
    const how = await decide(ctx, c, waiting);
    if (how === "turn") done.turns++;
    if (how === "relayed" || how === "busy") done.relayed++;
  }
  return done;
}

export const takeAction = defineAction({
  name: "slack.take",
  description:
    "Take what people in your Slack wrote to Jarvis's bot: who wrote it, their conversation, and whether Jarvis answers or passes it on to you.",
  input: z.object({}),
  risk: "internal",
  // Only as the integration, from the worker (D62): what it writes is outside content.
  callers: ["integration"],
  auditWhen: (r: TakeRound) => r.taken + r.turns + r.relayed + r.settled > 0,
  handler: (_i, ctx) => takeRound(ctx),
});
