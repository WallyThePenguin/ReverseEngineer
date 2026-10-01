// The event log: append (in the writer's transaction), read after a cursor, and listen.

import type { Origin } from "@hearth/core";
import { consumerCursor, type DbOrTx, event, type Tx } from "@hearth/db";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type pg from "pg";
import { newId } from "./ids.ts";
import type { EmitEvent, HearthEvent } from "./types.ts";

export interface EventStamp {
  actor: string;
  origin: Origin;
  correlationId?: string | null;
  causationId?: string | null;
  at: Date;
}

/**
 * Appends events inside the caller's transaction. The advisory lock is held until commit, so
 * seq order equals commit order and readers never skip a late-committing event. Call this at
 * the end of a transaction, not the start.
 */
export async function appendEvents(
  tx: Tx,
  events: EmitEvent[],
  stamp: EventStamp,
): Promise<HearthEvent[]> {
  if (events.length === 0) return [];
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('hearth_event_log'))`);
  const rows = await tx
    .insert(event)
    .values(
      events.map((e) => ({
        id: newId(),
        at: stamp.at,
        kind: e.kind,
        entityId: e.entityId ?? null,
        actor: stamp.actor,
        origin: stamp.origin,
        payload: e.payload ?? {},
        correlationId: stamp.correlationId ?? null,
        causationId: stamp.causationId ?? null,
      })),
    )
    .returning();
  return rows.map(toHearthEvent);
}

export function toHearthEvent(row: typeof event.$inferSelect): HearthEvent {
  return {
    seq: row.seq,
    id: row.id,
    at: row.at,
    kind: row.kind,
    entityId: row.entityId,
    actor: row.actor,
    origin: row.origin,
    payload: row.payload,
    correlationId: row.correlationId,
    causationId: row.causationId,
  };
}

export async function readEventsAfter(
  db: DbOrTx,
  afterSeq: number,
  opts: { limit?: number; kinds?: string[] } = {},
): Promise<HearthEvent[]> {
  const where = opts.kinds?.length
    ? and(gt(event.seq, afterSeq), inArray(event.kind, opts.kinds))
    : gt(event.seq, afterSeq);
  const rows = await db
    .select()
    .from(event)
    .where(where)
    .orderBy(asc(event.seq))
    .limit(opts.limit ?? 200);
  return rows.map(toHearthEvent);
}

export async function latestSeq(db: DbOrTx): Promise<number> {
  const [row] = await db.select({ max: sql<number | null>`max(${event.seq})` }).from(event);
  return Number(row?.max ?? 0);
}

export async function getCursor(db: DbOrTx, consumer: string): Promise<number> {
  const [row] = await db.select().from(consumerCursor).where(eq(consumerCursor.consumer, consumer));
  return row?.seq ?? 0;
}

export async function setCursor(db: DbOrTx, consumer: string, seq: number): Promise<void> {
  await db
    .insert(consumerCursor)
    .values({ consumer, seq, updatedAt: new Date() })
    .onConflictDoUpdate({ target: consumerCursor.consumer, set: { seq, updatedAt: new Date() } });
}

/**
 * Calls `onEvent` with the newest seq whenever events are committed. Reconnects on failure.
 * Returns a stop function.
 */
export function listenForEvents(
  pool: pg.Pool,
  onEvent: (seq: number) => void,
): () => Promise<void> {
  let stopped = false;
  let client: pg.PoolClient | null = null;
  let retry: NodeJS.Timeout | null = null;

  const connect = async () => {
    if (stopped) return;
    try {
      client = await pool.connect();
      client.on("notification", (msg) => {
        if (msg.channel === "hearth_event") onEvent(Number(msg.payload));
      });
      client.on("error", () => reconnect());
      await client.query("LISTEN hearth_event");
    } catch {
      reconnect();
    }
  };
  const reconnect = () => {
    const c = client;
    client = null;
    c?.release(true);
    if (!stopped && !retry) {
      retry = setTimeout(() => {
        retry = null;
        void connect();
      }, 1000);
    }
  };
  void connect();

  return async () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    const c = client;
    client = null;
    if (c) {
      await c.query("UNLISTEN hearth_event").catch(() => {});
      c.release();
    }
  };
}
