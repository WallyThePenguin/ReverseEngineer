import { audit, type DbOrTx } from "@hearth/db";
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

/** One row per action call. Inputs of secret actions are never stored. */
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
