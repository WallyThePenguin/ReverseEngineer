// A post to a member checked once more as the outbox sends it (D62). It may have waited: for Slack's
// "slow down", or up to a day for the bot's new tokens. Whatever changed meanwhile counts.
// - An answer to someone you've blocked since, or with members off, doesn't go; with Jarvis
//   paused it doesn't either, unless you said yes to it yourself, having read it. One that went
//   on its own doesn't go once you've lowered their tier (or the channel's) below the one it was
//   written at, or put replies to them on review: inside the turn, either would have held it for
//   your yes. You're told, with its text.
// - A fixed note doesn't go to someone you've blocked since, or with members off; nor are you
//   told, as nobody wrote it. The note that tells someone they're blocked still goes.
import { approval, type Db, jarvisTurn, principal, slackThread, slackUser } from "@hearth/db";
import { getSetting } from "@hearth/kernel";
import { and, eq, inArray } from "drizzle-orm";
import { isUser } from "../bot/not-sent.ts";
import type { OutboxRow } from "../bot/queue.ts";
import { REPLY_ACTION } from "../bot/settings.ts";
import { reaches } from "./people.ts";
import { memberGate } from "./turn.ts";

const STOPPED: Record<string, string> = {
  members_off: "You've turned off Jarvis answering people in your Slack.",
  paused: "Jarvis was paused before it went out.",
};

type Row = Pick<OutboxRow, "kind" | "turnId" | "channelId">;

/** Whether you said yes to the turn's answer yourself, having read it. */
async function approved(db: Db, turnId: string) {
  const [yes] = await db
    .select({ id: approval.id })
    .from(approval)
    .where(
      and(
        eq(approval.turnId, turnId),
        eq(approval.action, REPLY_ACTION),
        inArray(approval.status, ["executing", "executed"]),
      ),
    )
    .limit(1);
  return Boolean(yes);
}

/** Why an outbox row that answers a member mustn't go now, or null when it may. */
export async function answerStopped(db: Db, row: Row, now: Date): Promise<string | null> {
  if (row.kind !== "answer" || !row.turnId) return null;
  const [turn] = await db
    .select({
      id: jarvisTurn.id,
      conversationId: jarvisTurn.conversationId,
      context: jarvisTurn.context,
    })
    .from(jarvisTurn)
    .where(eq(jarvisTurn.id, row.turnId));
  if (!turn) return null;
  const gate = await memberGate(db, turn, now);
  if (!gate.ok && gate.why === "blocked")
    return row.channelId.startsWith("D") || isUser(row.channelId)
      ? "You've blocked them since it was written."
      : "Jarvis is off in that channel now, or you've blocked them.";
  if (!gate.ok && gate.why !== "paused")
    return STOPPED[gate.why] ?? "Jarvis no longer answers them.";
  if (await approved(db, row.turnId)) return null;
  if (!gate.ok) return STOPPED.paused!;
  // In plain words, without their name: the card's title has it, and what's kept has none (D58).
  const { tier, replies, thread } = gate.member;
  const there = thread?.audience === "channel" ? " in that channel" : "";
  if (replies === "review")
    return `You set replies to them${there} to wait for your yes while this waited.`;
  const wrote = turn.context.answeredAs;
  if ((wrote === "relay" || wrote === "schedule") && !reaches(tier, wrote))
    return there
      ? "You lowered what Jarvis may tell them in that channel while this waited."
      : `You lowered them to ${tier} while this waited.`;
  return null;
}

/** Whether a fixed note mustn't go now: members off, or to someone you've blocked since. */
export async function noteStopped(
  db: Db,
  row: Pick<OutboxRow, "kind" | "dedupeKey" | "channelId" | "ephemeralTo">,
) {
  if (row.kind !== "note" || row.dedupeKey.startsWith("note:blocked:")) return false;
  if (!(await getSetting(db, "slack.bot.membersOn"))) return true;
  const to = row.ephemeralTo ?? (isUser(row.channelId) ? row.channelId : null);
  let who = to ? eq(slackUser.id, to) : null;
  if (!who) {
    const [t] = await db
      .select({ member: slackThread.member })
      .from(slackThread)
      .where(and(eq(slackThread.channelId, row.channelId), eq(slackThread.threadTs, "")));
    if (!t?.member) return false;
    who = eq(slackUser.principal, t.member);
  }
  const [u] = await db
    .select({ tier: slackUser.tier, off: principal.disabledAt })
    .from(slackUser)
    .leftJoin(principal, eq(principal.id, slackUser.principal))
    .where(who);
  return u?.tier === "blocked" || Boolean(u?.off);
}
