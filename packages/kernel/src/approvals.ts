// The approval inbox: anything Jarvis (or another agent) wants to do that needs your yes waits
// here, and runs as the original requester once you approve it. Each runs at most once (D58):
// the same request waits once, a yes claims the approval before the action runs, and what's
// approved is checked again against the action before it runs.
import { isUuid } from "@hearth/core";
import { type ApprovalStatus, approval, notification, principal, type Tx } from "@hearth/db";
import { and, eq, gt, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";
import { alwaysAllowOf, alwaysAllowRule, NOT_ALWAYS, writeStandingRule } from "./always-allow.ts";
import { approvalTtlMs, expireOverdue, resolvedOrigin, withTitles } from "./approval-life.ts";
import { writeAudit } from "./audit.ts";
import { ActionError, describeError } from "./errors.ts";
import { appendEvents, type EventStamp } from "./events.ts";
import { newId, stableHash } from "./ids.ts";
import type { ExecuteResult, Kernel } from "./kernel.ts";
import { createNotification } from "./notify.ts";
import { holdsOutside } from "./outside.ts";
import type { ActionDef, Caller, EmitEvent } from "./types.ts";

export type ApprovalRow = typeof approval.$inferSelect;

/** Events to append once a transaction's other writes are done (the event lock comes last). */
export interface Deferred {
  events: EmitEvent[];
  stamp: EventStamp;
}

/** A value as JSON stores it, so the hash is of exactly what's kept (a Date becomes its text). */
const asStored = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? {}));

export async function requestApproval(
  kernel: Kernel,
  def: ActionDef,
  input: unknown,
  caller: Caller & { correlationId: string },
  reason: string,
): Promise<ApprovalRow> {
  const now = kernel.clock.now();
  const stored = asStored(input);
  const inputHash = stableHash(stored);
  const summary = def.summarize?.(input as never) ?? def.description;
  // Two identical requests at once: the second waits on the first's insert, then reuses it.
  // Should that one be decided in between, there's nothing waiting any more, so ask afresh.
  for (let attempt = 0; ; attempt++) {
    const row = await kernel.db.transaction(async (tx) => {
      const id = newId();
      const [created] = await tx
        .insert(approval)
        .values({
          id,
          action: def.name,
          input: stored,
          inputHash,
          risk: def.risk,
          summary,
          reason,
          requestedBy: caller.principal,
          origin: caller.origin,
          turnId: caller.turnId ?? null,
          conversationId: caller.conversationId ?? null,
          correlationId: caller.correlationId,
          createdAt: now,
          expiresAt: new Date(now.getTime() + approvalTtlMs(def.risk)),
          // Only where a rule would answer it: a page's own check (askFirst) asks whatever the
          // rules say. Whether the card offers it is its origin's call, which can still drop (D70).
          alwaysAllow:
            caller.kind === "agent" && !caller.askFirst ? alwaysAllowOf(def, input) : null,
        })
        .onConflictDoNothing()
        .returning();
      const row = created ?? (await reuseWaiting(tx, def, inputHash, caller));
      if (!row) return null;
      if (created) await announce(kernel, tx, row, caller, now);
      await writeAudit(tx, {
        def,
        caller,
        input: stored,
        outcome: "pending_approval",
        durationMs: 0,
        correlationId: caller.correlationId,
        approvalId: row.id,
        at: now,
      });
      return row;
    });
    if (row) return row;
    if (attempt >= 2)
      throw new ActionError("conflict", "This request was just decided. Try again.");
  }
}

/** The same request from the same asker, still waiting. It stays as cautious as its most
 * cautious asker: one made after reading outside content makes it untrusted (D25). */
async function reuseWaiting(
  tx: Tx,
  def: ActionDef,
  inputHash: string,
  caller: Caller,
): Promise<ApprovalRow | null> {
  const [waiting] = await tx
    .select()
    .from(approval)
    .where(
      and(
        eq(approval.action, def.name),
        eq(approval.inputHash, inputHash),
        eq(approval.requestedBy, caller.principal),
        eq(approval.status, "pending"),
      ),
    )
    .for("update");
  if (!waiting) return null;
  if (caller.origin !== "untrusted" || waiting.origin === "untrusted") return waiting;
  const [lowered] = await tx
    .update(approval)
    .set({ origin: "untrusted" })
    .where(eq(approval.id, waiting.id))
    .returning();
  return lowered ?? waiting;
}

/** The inbox card and the approval.requested event for a new approval. */
async function announce(
  kernel: Kernel,
  tx: Tx,
  row: ApprovalRow,
  caller: Caller & { correlationId: string },
  now: Date,
) {
  const [who] = await tx.select().from(principal).where(eq(principal.id, caller.principal));
  const buffered: EmitEvent[] = [];
  const emit = (e: EmitEvent) => buffered.push(e);
  // A summary's first paragraph is the title; the rest (an email's text) is shown in full.
  const [first = "", ...rest] = row.summary.split("\n\n");
  const named = await withTitles(tx, first, (t) => kernel.registry.isOutsideType(t));
  await createNotification(
    { tx, now, caller, emit },
    {
      kind: "approval",
      title: `${who?.displayName ?? caller.principal} asks: ${named}`,
      body: [rest.join("\n\n"), row.reason].filter(Boolean).join("\n\n"),
      approvalId: row.id,
      dedupeKey: `approval:${row.id}`,
    },
  );
  emit({
    kind: "approval.requested",
    payload: {
      approvalId: row.id,
      action: row.action,
      summary: row.summary,
      requestedBy: caller.principal,
      reason: row.reason,
    },
  });
  await appendEvents(tx, buffered, {
    actor: caller.principal,
    origin: caller.origin,
    correlationId: caller.correlationId,
    causationId: caller.causationId ?? null,
    at: now,
  });
}

const TAKEN: Record<ApprovalStatus, string> = {
  pending: "This approval is still waiting.",
  executing: "This is already being done.",
  executed: "This was already approved and done.",
  denied: "This was already denied.",
  failed: "This was already approved, and it failed.",
  expired: "This approval ran out before anyone decided. Ask again if you still want it.",
};
const GONE = "Hearth can no longer do what this asked, so nothing was run.";
const NOT_RUN = "Hearth couldn't start this, so nothing was run. Ask for it again.";

export async function resolveApproval(
  kernel: Kernel,
  approvalId: string,
  decision: "approve" | "deny",
  caller: Caller,
  /** Always allow (D70): the yes also writes the card's rule, or neither happens. */
  opts: { alwaysAllow?: boolean } = {},
): Promise<ExecuteResult> {
  if (caller.kind !== "owner")
    return { status: "denied", reason: "Only you can decide approvals." };
  const notFound = { status: "error", code: "not_found", message: "Approval not found" } as const;
  if (!isUuid(approvalId)) return notFound;
  const [row] = await kernel.db.select().from(approval).where(eq(approval.id, approvalId));
  if (!row) return notFound;
  const always = decision === "approve" && opts.alwaysAllow === true;
  if (always && !alwaysAllowRule(row)) return { status: "denied", reason: NOT_ALWAYS };
  const def = kernel.registry.action(row.action);
  // As it is when closed: a copy asked meanwhile after reading outside content may lower it.
  let origin = row.origin;
  const now = kernel.clock.now();
  const correlationId = row.correlationId ?? newId();
  const stillOpen = and(
    eq(approval.id, approvalId),
    eq(approval.status, "pending"),
    or(isNull(approval.expiresAt), gt(approval.expiresAt, now)),
  );
  // Someone (you on another device, or the clock) got there first: say so plainly.
  const taken = async (): Promise<ExecuteResult> => {
    await expireOverdue(kernel.db, now, approvalId);
    const [r] = await kernel.db
      .select({ status: approval.status })
      .from(approval)
      .where(eq(approval.id, approvalId));
    return { status: "error", code: "conflict", message: TAKEN[r?.status ?? "expired"] };
  };

  // Closes the approval, if it's still in `from`; the event goes last (see Deferred).
  const close = async (
    tx: Tx,
    from: ApprovalStatus,
    status: ApprovalStatus,
    extra: Partial<ApprovalRow>,
    touchedOutside = false,
  ): Promise<Deferred | null> => {
    const updated = await tx
      .update(approval)
      .set({
        status,
        ...(from === "pending" ? { decidedBy: caller.principal, decidedAt: now } : {}),
        ...extra,
      })
      .where(
        from === "pending"
          ? stillOpen
          : and(eq(approval.id, approvalId), eq(approval.status, from)),
      )
      .returning({ id: approval.id, origin: approval.origin });
    if (updated.length === 0) return null;
    origin = updated[0]!.origin;
    await tx
      .update(notification)
      .set({ state: "done", updatedAt: now })
      .where(and(eq(notification.approvalId, approvalId), ne(notification.state, "done")));
    return {
      events: [
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
      stamp: {
        actor: caller.principal,
        origin: resolvedOrigin({ origin }, def, touchedOutside),
        correlationId,
        at: now,
      },
    };
  };
  const finish = async (
    from: ApprovalStatus,
    status: ApprovalStatus,
    extra: Partial<ApprovalRow>,
  ) =>
    kernel.db.transaction(async (tx) => {
      const d = await close(tx, from, status, extra);
      if (d) await appendEvents(tx, d.events, d.stamp);
      return d !== null;
    });

  if (decision === "deny" || !def) {
    const closed = await finish(
      "pending",
      "denied",
      def ? {} : { error: "Action no longer exists" },
    );
    if (!closed) return taken();
    // A yes to an action Hearth no longer has closes it too, but nothing ran: say so.
    return def || decision === "deny"
      ? { status: "ok", result: { decision: "denied" } }
      : { status: "error", code: "conflict", message: GONE };
  }

  // Claimed before anything runs: a second yes finds it taken instead of running it again. An
  // Always allow claims it only while it's still from a conversation you started alone.
  const [claimed] = await kernel.db
    .update(approval)
    .set({ status: "executing", decidedBy: caller.principal, decidedAt: now })
    .where(always ? and(stillOpen, eq(approval.origin, "owner")) : stillOpen)
    .returning();
  if (!claimed) {
    const [r] = always ? await kernel.db.select().from(approval).where(stillOpen) : [];
    // Still waiting, but a turn that read an email has since asked for the same thing.
    return r ? { status: "denied", reason: NOT_ALWAYS } : taken();
  }
  const rule = always ? alwaysAllowRule(claimed) : null;
  // `error` is kept on the approval (and told to Jarvis); you're told `message`.
  const fail = async (message: string, error = message): Promise<ExecuteResult> => {
    await finish("executing", "failed", { error });
    return { status: "error", code: "conflict", message };
  };
  if (stableHash(claimed.input) !== claimed.inputHash)
    return fail("The approved request doesn't match what was asked, so it wasn't run.");
  // What it would run is checked against the action as it is now, defaults and all.
  const parsed = def.input.safeParse(claimed.input);
  if (!parsed.success)
    return fail(
      "This request no longer fits what Hearth can do, so it wasn't run. Ask for it again.",
      `This request no longer fits ${def.name}, so it wasn't run: ${z.prettifyError(parsed.error)}`,
    );

  let requester: Caller & { correlationId: string };
  try {
    requester = {
      principal: claimed.requestedBy,
      kind: await kernel.principalKind(claimed.requestedBy),
      origin: claimed.origin as Caller["origin"],
      via: "ui",
      correlationId,
      ...(claimed.turnId ? { turnId: claimed.turnId } : {}),
      ...(claimed.conversationId ? { conversationId: claimed.conversationId } : {}),
    };
  } catch (err) {
    // Couldn't even look up who asked: close it now rather than leave it "being done" until
    // the sweep says it may or may not have happened.
    const failure = describeError(err);
    await finish("executing", "failed", { error: failure.message }).catch(() => {});
    return failure.code === "unavailable"
      ? { status: "error", ...failure }
      : { status: "error", code: "failed", message: NOT_RUN };
  }
  const result = await kernel.run(def, parsed.data, requester, {
    approvalId,
    inTx: async (tx, r) => {
      // A result that shows outside content (an email it found) reaches Jarvis as untrusted.
      const touched = await holdsOutside(tx, (t) => kernel.registry.isOutsideType(t), r);
      const result = (r ?? null) as ApprovalRow["result"];
      const d = await close(tx, "executing", "executed", { result }, touched);
      if (!d) throw new ActionError("conflict", "This approval was closed while it ran.");
      // With the yes it came with: a yes that fails or is refused leaves no rule (D70).
      if (rule)
        await writeStandingRule(
          tx,
          { action: row.action, target: rule.target, note: rule.says },
          now,
        );
      return d;
    },
  });
  if (result.status !== "ok") {
    const message = result.status === "error" ? result.message : "Could not run";
    await finish("executing", "failed", { error: message });
  }
  return result;
}
