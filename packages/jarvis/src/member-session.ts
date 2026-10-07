// A Slack member's DM and its agent session (D62): when the next turn carries it on, and what a
// new one starts from. The session holds what the model wrote as if it had been said, so it's
// dropped whenever an answer didn't go out (you declined it, it lapsed, it waits for your yes, or
// it was stopped or failed on its way), and when you change the member's tier or review. A new
// session starts from the recap, which has Jarvis's words only as they went out.
import { approval, conversation, jarvisTurn, slackOutbox } from "@hearth/db";
import { REPLY_ACTION } from "@hearth/modules";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { EndEnv } from "./turn-end.ts";

/** A member's conversation starts a new agent session after this long idle (D62). */
export const MEMBER_IDLE_MS = 12 * 3_600_000;

/**
 * Whether a DM starts afresh rather than carry on its session: its last answered turn was long
 * enough ago, or that turn's reply hasn't gone. It waits for your yes, you declined it, it lapsed
 * or failed after your yes, or it was stopped or failed on its way out (D62).
 */
export async function afreshDue(env: EndEnv, cid: string, turnId: string, now: Date) {
  const { db } = env.kernel;
  const [last] = await db
    .select({ id: jarvisTurn.id, at: jarvisTurn.finishedAt })
    .from(jarvisTurn)
    .where(
      and(
        eq(jarvisTurn.conversationId, cid),
        eq(jarvisTurn.status, "done"),
        ne(jarvisTurn.id, turnId),
      ),
    )
    .orderBy(desc(jarvisTurn.finishedAt))
    .limit(1);
  if (!last?.at || now.getTime() - last.at.getTime() > MEMBER_IDLE_MS) return true;
  const [held] = await db
    .select({ id: approval.id })
    .from(approval)
    .where(
      and(
        eq(approval.action, REPLY_ACTION),
        eq(approval.turnId, last.id),
        inArray(approval.status, ["pending", "denied", "expired", "failed"]),
      ),
    )
    .limit(1);
  if (held) return true;
  const [lost] = await db
    .select({ id: slackOutbox.id })
    .from(slackOutbox)
    .where(
      and(
        eq(slackOutbox.dedupeKey, `answer:${last.id}`),
        inArray(slackOutbox.state, ["failed", "expired"]),
      ),
    );
  return Boolean(lost);
}

/** What each turn of a conversation sent, or is sending: its answer as it went out. */
export async function answered(env: EndEnv, cid: string): Promise<Map<string, string>> {
  const rows = await env.kernel.db
    .select({ turnId: slackOutbox.turnId, text: slackOutbox.text })
    .from(slackOutbox)
    .where(
      and(
        eq(slackOutbox.conversationId, cid),
        eq(slackOutbox.kind, "answer"),
        inArray(slackOutbox.state, ["queued", "sending", "sent", "unknown"]),
      ),
    );
  return new Map(rows.flatMap((r) => (r.turnId ? [[r.turnId, r.text] as const] : [])));
}

/** Its DM's next turn starts afresh, from what Hearth kept, instead of this session. */
export const forgetSession = (env: EndEnv, cid: string) =>
  env.kernel.db
    .update(conversation)
    .set({ agentSessionId: null })
    .where(eq(conversation.entityId, cid));

/**
 * Keeps the session a turn ended with, unless its DM's session changed while the turn ran (`was`
 * is what it was then): you changed the member's tier or review, or one of their answers failed
 * to go, and that cleared it.
 */
export const keepIfUnchanged = (env: EndEnv, cid: string, sessionId: string, was: string | null) =>
  env.kernel.db
    .update(conversation)
    .set({ agentSessionId: sessionId })
    .where(
      and(
        eq(conversation.entityId, cid),
        was === null ? isNull(conversation.agentSessionId) : eq(conversation.agentSessionId, was),
      ),
    );
