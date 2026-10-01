// The approval inbox: anything Jarvis (or another agent) wants to do that needs your yes waits
// here, and runs as the original requester once you approve it.
import { approval, notification, principal } from "@hearth/db";
import { and, eq, ne } from "drizzle-orm";
import { writeAudit } from "./audit.ts";
import { ActionError } from "./errors.ts";
import { appendEvents } from "./events.ts";
import { newId, stableHash } from "./ids.ts";
import type { ExecuteResult, Kernel } from "./kernel.ts";
import { createNotification } from "./notify.ts";
import type { ActionDef, Caller, EmitEvent } from "./types.ts";

export type ApprovalRow = typeof approval.$inferSelect;

export async function requestApproval(
  kernel: Kernel,
  def: ActionDef,
  input: unknown,
  caller: Caller & { correlationId: string },
  reason: string,
): Promise<ApprovalRow> {
  const now = kernel.clock.now();
  return kernel.db.transaction(async (tx) => {
    const id = newId();
    const summary = def.summarize?.(input as never) ?? def.description;
    const [row] = await tx
      .insert(approval)
      .values({
        id,
        action: def.name,
        input: input ?? {},
        inputHash: stableHash(input ?? {}),
        risk: def.risk,
        summary,
        reason,
        requestedBy: caller.principal,
        origin: caller.origin,
        turnId: caller.turnId ?? null,
        conversationId: caller.conversationId ?? null,
        correlationId: caller.correlationId,
        createdAt: now,
      })
      .returning();
    const [who] = await tx.select().from(principal).where(eq(principal.id, caller.principal));
    const buffered: EmitEvent[] = [];
    const emit = (e: EmitEvent) => buffered.push(e);
    await createNotification(
      { tx, now, caller, emit },
      {
        kind: "approval",
        title: `${who?.displayName ?? caller.principal} asks: ${summary}`,
        body: reason,
        approvalId: id,
        dedupeKey: `approval:${id}`,
      },
    );
    emit({
      kind: "approval.requested",
      payload: { approvalId: id, action: def.name, summary, requestedBy: caller.principal, reason },
    });
    await appendEvents(tx, buffered, {
      actor: caller.principal,
      origin: caller.origin,
      correlationId: caller.correlationId,
      causationId: caller.causationId ?? null,
      at: now,
    });
    await writeAudit(tx, {
      def,
      caller,
      input,
      outcome: "pending_approval",
      durationMs: 0,
      correlationId: caller.correlationId,
      approvalId: id,
      at: now,
    });
    return row!;
  });
}

export async function resolveApproval(
  kernel: Kernel,
  approvalId: string,
  decision: "approve" | "deny",
  caller: Caller,
): Promise<ExecuteResult> {
  if (caller.kind !== "owner")
    return { status: "denied", reason: "Only you can decide approvals." };
  const [row] = await kernel.db.select().from(approval).where(eq(approval.id, approvalId));
  if (!row) return { status: "error", code: "not_found", message: "Approval not found" };
  if (row.status !== "pending") {
    return { status: "error", code: "conflict", message: `Already ${row.status}` };
  }
  const def = kernel.registry.action(row.action);
  const now = kernel.clock.now();
  const correlationId = row.correlationId ?? newId();

  const close = async (
    tx: Parameters<Parameters<typeof kernel.db.transaction>[0]>[0],
    status: ApprovalRow["status"],
    extra: Partial<ApprovalRow>,
  ) => {
    const updated = await tx
      .update(approval)
      .set({ status, decidedBy: caller.principal, decidedAt: now, ...extra })
      .where(and(eq(approval.id, approvalId), eq(approval.status, "pending")))
      .returning({ id: approval.id });
    if (updated.length === 0)
      throw new ActionError("conflict", "Someone already decided this approval");
    await tx
      .update(notification)
      .set({ state: "done", updatedAt: now })
      .where(and(eq(notification.approvalId, approvalId), ne(notification.state, "done")));
    await appendEvents(
      tx,
      [
        {
          kind: "approval.resolved",
          payload: {
            approvalId,
            action: row.action,
            decision: status === "denied" ? "denied" : "approved",
            requestedBy: row.requestedBy,
            conversationId: row.conversationId,
            turnId: row.turnId,
            ...(extra.error ? { error: extra.error } : {}),
            ...(extra.result !== undefined ? { result: extra.result } : {}),
          },
        },
      ],
      { actor: caller.principal, origin: "owner", correlationId, at: now },
    );
  };

  if (decision === "deny" || !def) {
    await kernel.db.transaction((tx) =>
      close(tx, "denied", def ? {} : { error: "Action no longer exists" }),
    );
    return { status: "ok", result: { decision: "denied" } };
  }
  if (stableHash(row.input) !== row.inputHash) {
    return {
      status: "error",
      code: "conflict",
      message: "The approved input doesn't match what was requested",
    };
  }

  const requester: Caller & { correlationId: string } = {
    principal: row.requestedBy,
    kind: await kernel.principalKind(row.requestedBy),
    origin: row.origin as Caller["origin"],
    via: "ui",
    correlationId,
    ...(row.turnId ? { turnId: row.turnId } : {}),
    ...(row.conversationId ? { conversationId: row.conversationId } : {}),
  };
  const result = await kernel.run(def, row.input, requester, {
    approvalId,
    inTx: (tx, r) => close(tx, "executed", { result: (r ?? null) as ApprovalRow["result"] }),
  });
  if (result.status !== "ok") {
    const message = result.status === "error" ? result.message : "Could not run";
    await kernel.db
      .transaction((tx) => close(tx, "failed", { error: message }))
      .catch((err) => {
        if (!(err instanceof ActionError)) throw err;
      });
  }
  return result;
}
