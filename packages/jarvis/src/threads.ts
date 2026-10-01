// Where a turn lives: its conversation (a chat, or the thread of the record it's about), and
// writing to that conversation's log with live events and streamed text.
import { formatDateTime } from "@hearth/core";
import { conversation, entity, type Tx } from "@hearth/db";
import { appendEvents, jarvisCaller, type Kernel } from "@hearth/kernel";
import { appendLog, type LogEntry } from "@hearth/modules";
import { eq } from "drizzle-orm";
import type pg from "pg";

export const STREAM_CHANNEL = "hearth_stream";

export interface TurnLike {
  id: string;
  trigger: string;
  origin: string;
  conversationId: string | null;
  subjectId: string | null;
  context: Record<string, unknown>;
}

const ROUTINE_TITLES: Record<string, string> = {
  brief: "Morning brief",
  journal: "Evening journal",
  heartbeat: "Heartbeat",
};

/** Finds or creates the conversation a turn belongs to. */
export async function ensureConversation(kernel: Kernel, turn: TurnLike): Promise<string> {
  if (turn.conversationId) return turn.conversationId;
  if (turn.subjectId) {
    const [existing] = await kernel.db
      .select()
      .from(conversation)
      .where(eq(conversation.subjectId, turn.subjectId));
    if (existing) return existing.entityId;
    const [subject] = await kernel.db.select().from(entity).where(eq(entity.id, turn.subjectId));
    const res = await kernel.execute<{ id: string }>(
      "conversation.create",
      { title: `Thread: ${subject?.title || "record"}`, subjectId: turn.subjectId },
      jarvisCaller("agent", { turnId: turn.id }),
    );
    if (res.status === "ok") return res.result.id;
    // Lost a race with another turn on the same subject: use the winner's conversation.
    const [winner] = await kernel.db
      .select()
      .from(conversation)
      .where(eq(conversation.subjectId, turn.subjectId));
    if (winner) return winner.entityId;
    throw new Error(`Could not create a thread conversation: ${JSON.stringify(res)}`);
  }
  const routine = typeof turn.context.routine === "string" ? turn.context.routine : null;
  const label = routine ? (ROUTINE_TITLES[routine] ?? routine) : `Jarvis ${turn.trigger}`;
  const res = await kernel.execute<{ id: string }>(
    "conversation.create",
    { title: `${label}, ${formatDateTime(kernel.clock.now())}` },
    jarvisCaller("agent", { turnId: turn.id }),
  );
  if (res.status !== "ok")
    throw new Error(`Could not create a conversation: ${JSON.stringify(res)}`);
  return res.result.id;
}

/** Appends to a conversation's log and announces it, in one transaction. */
export async function writeLog(
  kernel: Kernel,
  conversationId: string,
  entries: LogEntry[],
): Promise<void> {
  const now = kernel.clock.now();
  await kernel.db.transaction(async (tx: Tx) => {
    const idxs = await appendLog(tx, conversationId, entries, now);
    await appendEvents(
      tx,
      idxs.map((idx, i) => ({
        kind: "conversation.appended",
        entityId: conversationId,
        payload: {
          conversationId,
          idx,
          kind: entries[i]!.kind,
          turnId: entries[i]!.turnId ?? null,
        },
      })),
      { actor: "jarvis", origin: "agent", at: now },
    );
  });
}

/** Streams reply text to open screens without storing it (the full message is logged after). */
export function streamer(pool: pg.Pool | null, conversationId: string, turnId: string) {
  let buffer = "";
  let timer: NodeJS.Timeout | null = null;
  const flush = async () => {
    timer = null;
    if (!pool || !buffer) return;
    const delta = buffer.slice(0, 3000);
    buffer = buffer.slice(3000);
    await pool
      .query("SELECT pg_notify($1, $2)", [
        STREAM_CHANNEL,
        JSON.stringify({ conversationId, turnId, delta }),
      ])
      .catch(() => {});
    if (buffer) await flush();
  };
  return {
    push(delta: string) {
      buffer += delta;
      timer ??= setTimeout(() => void flush(), 50);
    },
    async end() {
      if (timer) clearTimeout(timer);
      await flush();
    },
  };
}
