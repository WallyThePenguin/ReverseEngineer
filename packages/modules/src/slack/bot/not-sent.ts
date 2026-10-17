// Telling you about Jarvis's Slack posts that didn't go out, or may not have (D62): one card per
// post, naming who or where it was for. The sender (outbox.ts) tells you as posts fail; letting
// the bot or the whole workspace go settles every post not yet out, and tells you about each. A
// member's answer that didn't go also ends their DM's agent session, which has it as said.
import { PRINCIPAL } from "@hearth/core";
import {
  conversation,
  type DbOrTx,
  notification,
  slackChannel,
  slackOutbox,
  slackThread,
  slackUser,
  type Tx,
} from "@hearth/db";
import {
  type ActionContext,
  appendEvents,
  createNotification,
  type EmitEvent,
  type Kernel,
  newId,
  systemCaller,
} from "@hearth/kernel";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { named } from "../save.ts";
import type { OutboxRow } from "./queue.ts";

export const isUser = (channel: string) => /^[UW]/.test(channel);

/** Where a post was going, in words: a member's name, or a channel's. */
async function placeName(db: DbOrTx, row: OutboxRow): Promise<string> {
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
export async function tell(kernel: Kernel, row: OutboxRow, what: string, why: string) {
  const now = kernel.clock.now();
  await kernel.db.transaction(async (tx) => {
    const buffered: EmitEvent[] = [];
    const ctx = kernel.context(tx, { ...systemCaller(), correlationId: newId() }, now, buffered);
    await tellNotSent(ctx, row, what, why);
    await appendEvents(tx, buffered, { actor: PRINCIPAL.system, origin: "system", at: now });
  });
}

/** The card for one post, in a transaction of the caller's. */
export async function tellNotSent(ctx: ActionContext, row: OutboxRow, what: string, why: string) {
  const where = await placeName(ctx.tx, row);
  await createNotification(ctx, {
    kind: "slack.not_sent",
    title: `The Jarvis bot's Slack message to ${where} ${what}`,
    // All of it: the card shows what was stopped.
    body: `${why}\n\n${row.text}`,
    urgency: "normal",
    dedupeKey: notSentKey(row.id),
  });
}

/** The card's key, so a post Slack confirms after all can close it. */
export const notSentKey = (rowId: string) => `slack.outbox:${rowId}`;

/** Closes a post's card, since Slack has it after all; an open inbox drops it too. */
export async function closeNotSent(tx: Tx, rowId: string, now: Date) {
  const closed = await tx
    .update(notification)
    .set({ state: "done", updatedAt: now })
    .where(and(eq(notification.dedupeKey, notSentKey(rowId)), ne(notification.state, "done")))
    .returning({ id: notification.id, entityId: notification.entityId });
  await appendEvents(
    tx,
    closed.map((n) => ({
      kind: "notification.updated",
      entityId: n.entityId,
      payload: { notificationId: n.id, state: "done" },
    })),
    { actor: PRINCIPAL.system, origin: "system", at: now },
  );
}

/**
 * Members' answers that didn't go: their DMs start afresh, since the agent session there has
 * each one as said (D62). Whatever ended it: Slack refused it, it was stopped at the last check,
 * it waited a day, or you let the bot go.
 */
export async function forgetUnsaid(db: DbOrTx, rows: Pick<OutboxRow, "kind" | "conversationId">[]) {
  const ids = [
    ...new Set(
      rows.flatMap((r) => (r.kind === "answer" && r.conversationId ? [r.conversationId] : [])),
    ),
  ];
  if (ids.length)
    await db
      .update(conversation)
      .set({ agentSessionId: null })
      .where(inArray(conversation.entityId, ids));
}

/**
 * Waits for the take rounds, before letting the bot or the workspace go: a round holds people's
 * rows and their conversations, then queues on the bot's row, the other way round from a
 * disconnect, so one of the two would fail.
 */
export async function waitForTakeRounds(ctx: ActionContext) {
  await ctx.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('slack_take'))`);
  await ctx.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('slack_take_owner'))`);
}

/**
 * Settles every post of the workspace not yet out, once its bot is gone (deleted first, in this
 * transaction): nothing it hadn't sent goes out later, after a reconnect you may not expect it
 * from, and a post it was sending isn't looked for and posted again then either. You're told
 * about each (D62). Posts being queued meanwhile hold the bot's row (queue.ts), so they're
 * waited for and settled too.
 */
export async function settleUnsent(
  ctx: ActionContext,
  teamId: string,
  why: { unsent: string; unsure: string },
) {
  // One statement, so a post the sender puts back in the queue meanwhile isn't missed.
  const queued = sql`${slackOutbox.state} = 'queued'`;
  const rows = await ctx.tx
    .update(slackOutbox)
    .set({
      state: sql`CASE WHEN ${queued} THEN 'failed' ELSE 'unknown' END`,
      error: sql`CASE WHEN ${queued} THEN ${why.unsent} ELSE ${why.unsure} END`,
      finishedAt: ctx.now,
    })
    .where(and(eq(slackOutbox.teamId, teamId), inArray(slackOutbox.state, ["queued", "sending"])))
    .returning();
  const unsent = rows.filter((r) => r.state === "failed");
  const unsure = rows.filter((r) => r.state === "unknown");
  await forgetUnsaid(ctx.tx, unsent);
  for (const row of unsent) await tellNotSent(ctx, row, "didn't go out", row.error ?? "");
  for (const row of unsure) await tellNotSent(ctx, row, "may not have gone out", row.error ?? "");
  return { unsent: unsent.length, unsure: unsure.length };
}
