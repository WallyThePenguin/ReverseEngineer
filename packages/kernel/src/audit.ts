import { audit, type DbOrTx } from "@hearth/db";
import { sql } from "drizzle-orm";
import { newId } from "./ids.ts";
import type { ActionDef, Caller } from "./types.ts";

export interface AuditEntry {
  def: Pick<ActionDef, "name" | "risk">;
  caller: Caller;
  input: unknown;
  outcome: "ok" | "error" | "pending_approval" | "denied";
  error?: string | null;
  durationMs: number;
  correlationId: string;
  approvalId?: string | null;
  at: Date;
}

/**
 * Whether a call that went through gets an audit row. Everything Jarvis, an outside agent, an
 * integration, a job or a paired device does is kept, reads included, so their activity stays
 * visible. Your own reads from your own screens and the CLI aren't: they're most of the traffic,
 * they change nothing, and writing a row for each made every read a write (D56). Failures and
 * refusals are always kept.
 */
export function isAudited(def: Pick<ActionDef, "risk">, caller: Caller): boolean {
  return !(def.risk === "read" && caller.kind === "owner" && caller.origin === "owner");
}

/** How long routine audit rows are kept. Changes, failures and refusals are kept for good. */
export const AUDIT_KEEP = {
  /** Reads that went through (Jarvis's, outside agents', integrations'). */
  readDays: 90,
  /** Check-ins (system.report) and integrations' sync runs: thousands a day. */
  heartbeatDays: 14,
};

/**
 * Deletes routine audit rows past their keep: reads that went through, health check-ins and
 * integration syncs that worked. A batch at a time, so the table is never locked for long.
 * Returns how many went.
 */
export async function pruneAudit(
  db: DbOrTx,
  now: Date,
  keep = AUDIT_KEEP,
  batch = 5_000,
): Promise<number> {
  const day = 24 * 3_600_000;
  const reads = new Date(now.getTime() - keep.readDays * day);
  const beats = new Date(now.getTime() - keep.heartbeatDays * day);
  let total = 0;
  for (;;) {
    const res = await db.execute(sql`
      DELETE FROM audit WHERE id IN (
        SELECT id FROM audit
        WHERE outcome = 'ok' AND approval_id IS NULL AND at < ${reads > beats ? reads : beats}
          AND (
            (risk = 'read' AND at < ${reads})
            OR ((action = 'system.report'
                 OR (principal LIKE 'integration:%' AND action LIKE '%.sync'))
                AND at < ${beats})
          )
        LIMIT ${batch}
      )`);
    const n = res.rowCount ?? 0;
    total += n;
    if (n < batch) return total;
  }
}

/** One row per audited action call (see isAudited). Inputs of secret actions are never stored. */
export async function writeAudit(db: DbOrTx, e: AuditEntry): Promise<void> {
  await db.insert(audit).values({
    id: newId(),
    at: e.at,
    principal: e.caller.principal,
    origin: e.caller.origin,
    via: e.caller.via,
    action: e.def.name,
    risk: e.def.risk,
    input: e.def.risk === "secret" ? { redacted: true } : (e.input ?? null),
    outcome: e.outcome,
    error: e.error ?? null,
    durationMs: Math.round(e.durationMs),
    correlationId: e.correlationId,
    approvalId: e.approvalId ?? null,
  });
}
