// A member's answer checked once more as the outbox sends it (D62). It may have waited: for Slack's
// "slow down", or up to a day for the bot's new tokens. Whatever changed meanwhile counts: to
// someone you've blocked since, or with members off, it doesn't go; with Jarvis paused it doesn't
// either, unless you said yes to it yourself, having read it. You're told, with its text.
import { approval, type Db, jarvisTurn } from "@hearth/db";
import { and, eq, inArray } from "drizzle-orm";
import { REPLY_ACTION } from "../bot/settings.ts";
import { memberGate } from "./turn.ts";

const STOPPED: Record<string, string> = {
  members_off: "You've turned off Jarvis answering people in your Slack.",
  paused: "Jarvis was paused before it went out.",
};

/** Why an outbox row that answers a member mustn't go now, or null when it may. */
export async function answerStopped(
  db: Db,
  row: { kind: string; turnId: string | null; channelId: string },
  now: Date,
): Promise<string | null> {
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
  if (gate.ok) return null;
  if (gate.why === "paused") {
    const [yes] = await db
      .select({ id: approval.id })
      .from(approval)
      .where(
        and(
          eq(approval.turnId, row.turnId),
          eq(approval.action, REPLY_ACTION),
          inArray(approval.status, ["executing", "executed"]),
        ),
      )
      .limit(1);
    if (yes) return null;
  }
  if (gate.why === "blocked")
    return row.channelId.startsWith("D") || /^[UW]/.test(row.channelId)
      ? "You've blocked them since it was written."
      : "Jarvis is off in that channel now, or you've blocked them.";
  return STOPPED[gate.why] ?? "Jarvis no longer answers them.";
}
