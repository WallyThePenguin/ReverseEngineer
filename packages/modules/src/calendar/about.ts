// What a Jarvis turn is about: the records an event it adds may be tied to, and that tie is what
// lets it move or remove that event later without asking (D72).
import { conversation, type DbOrTx, heartbeatItem, jarvisTurn } from "@hearth/db";
import type { Caller } from "@hearth/kernel";
import { eq, inArray } from "drizzle-orm";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The turn's subject, its conversation's, and what the heartbeat items it took are about (an
 * email thread, a Slack conversation). Hearth's runtime sets the turn on the caller, never the
 * model, so a call outside a turn is about nothing.
 */
export async function turnSubjects(db: DbOrTx, caller: Caller): Promise<string[]> {
  if (!caller.turnId) return [];
  const [turn] = await db
    .select({
      subjectId: jarvisTurn.subjectId,
      conversationId: jarvisTurn.conversationId,
      context: jarvisTurn.context,
    })
    .from(jarvisTurn)
    .where(eq(jarvisTurn.id, caller.turnId));
  if (!turn) return [];
  const about: (string | null)[] = [turn.subjectId];
  if (turn.conversationId) {
    const [c] = await db
      .select({ subjectId: conversation.subjectId })
      .from(conversation)
      .where(eq(conversation.entityId, turn.conversationId));
    about.push(c?.subjectId ?? null);
  }
  const taken = turn.context.itemIds;
  const items = Array.isArray(taken) ? taken.map(String).filter((i) => UUID.test(i)) : [];
  if (items.length > 0) {
    const rows = await db
      .select({ aboutId: heartbeatItem.aboutId })
      .from(heartbeatItem)
      .where(inArray(heartbeatItem.id, items));
    about.push(...rows.map((r) => r.aboutId));
  }
  return [...new Set(about.filter((a): a is string => Boolean(a)))];
}
