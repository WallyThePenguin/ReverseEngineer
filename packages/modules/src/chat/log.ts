// A conversation's append-only log. The Jarvis runtime and chat.send both write through here.
import { conversation, conversationLog, type Tx } from "@hearth/db";
import { eq, sql } from "drizzle-orm";

export type LogKind =
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "approval_pending"
  | "turn_started"
  | "turn_finished"
  | "error"
  | "notice";

export interface LogEntry {
  kind: LogKind;
  payload: Record<string, unknown>;
  turnId?: string | null;
}

/** Appends entries in order and returns their indexes. Locks the conversation row. */
export async function appendLog(
  tx: Tx,
  conversationId: string,
  entries: LogEntry[],
  now: Date,
): Promise<number[]> {
  if (entries.length === 0) return [];
  await tx
    .select()
    .from(conversation)
    .where(eq(conversation.entityId, conversationId))
    .for("update");
  const [row] = await tx
    .select({ max: sql<number | null>`max(${conversationLog.idx})` })
    .from(conversationLog)
    .where(eq(conversationLog.conversationId, conversationId));
  let idx = row?.max == null ? 0 : Number(row.max) + 1;
  const out: number[] = [];
  for (const e of entries) {
    await tx.insert(conversationLog).values({
      conversationId,
      idx,
      at: now,
      turnId: e.turnId ?? null,
      kind: e.kind,
      payload: e.payload,
    });
    out.push(idx++);
  }
  await tx
    .update(conversation)
    .set({ lastTurnAt: now })
    .where(eq(conversation.entityId, conversationId));
  return out;
}

const DEEP_HINTS =
  /\b(plan|research|draft|write|analy[sz]e|review|compare|summari[sz]e|outline|brainstorm|design|investigate|why)\b/i;

/** Picks a lane without a model call: long or open-ended asks go deep, quick ones go fast. */
export function routeLane(text: string): "fast" | "deep" {
  if (text.length > 400 || text.split("\n").length > 6) return "deep";
  return DEEP_HINTS.test(text) ? "deep" : "fast";
}
