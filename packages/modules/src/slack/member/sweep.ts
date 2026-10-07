// Every member turn that ended without a reply gets the apology and a relay (D62), from the
// worker, so this still works with the Jarvis process stopped. A turn that failed, ran out of
// time, was stopped, or found the member blocked or paused when it started, leaves its messages
// claimed with nothing sent; one still "running" ten minutes on was cut short (its two minutes
// are long gone). Its messages are passed on to you, and the member hears why, once a day.
// A turn whose answer did go out (or waits for your yes) is settled as such: the reply's outbox
// row or its approval says so, even when the turn crashed before it could. Someone you blocked
// while their turn ran isn't sent the apology, nor passed on: the take loop turns them away.
import { approval, jarvisTurn, slackOutbox, type slackThread } from "@hearth/db";
import { type ActionContext, getSetting } from "@hearth/kernel";
import { and, eq } from "drizzle-orm";
import { type InboundRow, relayRows, settle, type Writer } from "./messages.ts";

type ThreadRow = typeof slackThread.$inferSelect;

/** A running turn this old has stopped for good: member turns have two minutes. */
export const STUCK_MS = 10 * 60_000;

/** Whether a member turn is over: finished, or cut short long ago. */
export function ended(turn: { status: string; startedAt: Date | null }, now: Date): boolean {
  if (turn.status === "queued") return false;
  if (turn.status !== "running") return true;
  return !turn.startedAt || turn.startedAt.getTime() < now.getTime() - STUCK_MS;
}

/** How a turn's claimed messages end up, once the turn is over. */
export async function settleClaimed(
  ctx: ActionContext,
  turnId: string,
  rows: InboundRow[],
  who: Writer,
  thread: ThreadRow | null,
  blocked = false,
): Promise<"answered" | "held" | "relayed" | "blocked" | "open"> {
  const [turn] = await ctx.tx
    .select({ status: jarvisTurn.status, startedAt: jarvisTurn.startedAt })
    .from(jarvisTurn)
    .where(eq(jarvisTurn.id, turnId));
  if (turn && !ended(turn, ctx.now)) return "open";
  const [sent] = await ctx.tx
    .select({ id: slackOutbox.id })
    .from(slackOutbox)
    .where(eq(slackOutbox.dedupeKey, `answer:${turnId}`));
  if (sent) {
    await settle(ctx, rows, "answered");
    return "answered";
  }
  const [held] = await ctx.tx
    .select({ id: approval.id })
    .from(approval)
    .where(and(eq(approval.turnId, turnId), eq(approval.action, "slack.reply")))
    .limit(1);
  if (held) {
    await settle(ctx, rows, "held");
    return "held";
  }
  if (blocked) return "blocked";
  const paused =
    (thread?.pausedUntil && thread.pausedUntil > ctx.now) ||
    (await getSetting(ctx.tx, "jarvis.paused"));
  await relayRows(ctx, who, rows, paused ? "paused" : "sorry");
  return "relayed";
}
