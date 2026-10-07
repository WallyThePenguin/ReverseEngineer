// Telling you about Jarvis's Slack posts that didn't go out, or may not have (D62): one card per
// post, naming who or where it was for. The sender (outbox.ts) tells you as posts fail; letting
// the bot or the whole workspace go settles every post not yet out, and tells you about each.
import { PRINCIPAL } from "@hearth/core";
import { type DbOrTx, slackChannel, slackOutbox, slackThread, slackUser } from "@hearth/db";
import {
  type ActionContext,
  appendEvents,
  createNotification,
  type EmitEvent,
  type Kernel,
  newId,
  systemCaller,
} from "@hearth/kernel";
import { and, eq } from "drizzle-orm";
import { preview } from "../../shared.ts";
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
    title: `Jarvis's Slack message to ${where} ${what}`,
    body: `${why}\n\n${preview(row.text, 300)}`,
    urgency: "normal",
    dedupeKey: notSentKey(row.id),
  });
}

/** The card's key, so a post Slack confirms after all can close it. */
export const notSentKey = (rowId: string) => `slack.outbox:${rowId}`;

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
  const team = eq(slackOutbox.teamId, teamId);
  const unsent = await ctx.tx
    .update(slackOutbox)
    .set({ state: "failed", error: why.unsent, finishedAt: ctx.now })
    .where(and(team, eq(slackOutbox.state, "queued")))
    .returning();
  const unsure = await ctx.tx
    .update(slackOutbox)
    .set({ state: "unknown", error: why.unsure, finishedAt: ctx.now })
    .where(and(team, eq(slackOutbox.state, "sending")))
    .returning();
  for (const row of unsent) await tellNotSent(ctx, row, "didn't go out", row.error ?? "");
  for (const row of unsure) await tellNotSent(ctx, row, "may not have gone out", row.error ?? "");
  return { unsent: unsent.length, unsure: unsure.length };
}
