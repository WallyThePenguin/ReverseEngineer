// Actions that wait on the world (B1, 1.15): a step in Chrome, the pause between steps on a site,
// a page loading. Run inside a transaction like other actions, they'd hold a database connection
// and an open transaction for seconds each, and enough of them at once would starve everything
// else. An action defined with `io: true` runs in three parts instead:
//   prepare: its reads (the owner's settings, a snapshot of what it acts on), each committed at
//            once, so nothing stays open;
//   effect:  the I/O, with no transaction held (pacing sleeps live here);
//   record:  one short transaction for its events, its audit row and, for an approved call,
//            closing the approval.
// The handler is written as usual; it just gets the database in place of a transaction, so an
// io action only reads there. What it emits is kept until the record, so a failed step leaves no
// events behind.
import type { Tx } from "@hearth/db";
import type { Deferred } from "./approvals.ts";
import { isAudited, writeAudit } from "./audit.ts";
import { ActionError, describeError, isDatabaseDown, logLine, stackFrames } from "./errors.ts";
import { appendEvents } from "./events.ts";
import type { ExecuteResult, Kernel } from "./kernel.ts";
import type { ActionDef, Caller, EmitEvent } from "./types.ts";

export interface RunHooks {
  approvalId?: string;
  /** Closes the approval; its events are appended after the action's own (see Deferred). */
  inTx?: (tx: Tx, result: unknown) => Promise<Deferred>;
}

/** Runs an allowed io action: its reads and I/O outside any transaction, its record in one. */
export async function runIo<R>(
  kernel: Kernel,
  def: ActionDef,
  input: unknown,
  caller: Caller & { correlationId: string },
  hooks: RunHooks,
  log: (msg: string) => void,
): Promise<ExecuteResult<R>> {
  const started = performance.now();
  const now = kernel.clock.now();
  const audited = isAudited(def, caller) || hooks.approvalId !== undefined;
  const buffered: EmitEvent[] = [];
  try {
    // prepare and effect: each query commits on its own; nothing waits on an open transaction.
    const ctx = kernel.context(kernel.db as unknown as Tx, caller, now, buffered);
    const result = (await def.handler(input, ctx)) as R;
    // record: the events, the audit row and the approval, together or not at all.
    await kernel.db.transaction(async (tx) => {
      if (audited && (hooks.approvalId !== undefined || (def.auditWhen?.(result) ?? true)))
        await writeAudit(tx, {
          def,
          caller,
          input,
          outcome: "ok",
          durationMs: performance.now() - started,
          correlationId: caller.correlationId,
          approvalId: hooks.approvalId ?? null,
          at: now,
        });
      // As in Kernel.run: the approval closes before the event log's lock is taken.
      const after = hooks.inTx ? await hooks.inTx(tx, result) : null;
      await appendEvents(tx, buffered, {
        actor: caller.principal,
        origin: caller.origin,
        correlationId: caller.correlationId,
        causationId: caller.causationId ?? null,
        at: now,
      });
      if (after) await appendEvents(tx, after.events, after.stamp);
    });
    return { status: "ok", result };
  } catch (err) {
    const failure = describeError(err);
    if (!(err instanceof ActionError)) {
      const where = isDatabaseDown(err) ? "" : stackFrames(err);
      log(`Action ${def.name} failed: ${logLine(err)}${where}`);
    }
    await writeAudit(kernel.db, {
      def,
      caller,
      input,
      outcome: "error",
      error: failure.message,
      durationMs: performance.now() - started,
      correlationId: caller.correlationId,
      approvalId: hooks.approvalId ?? null,
      at: now,
    }).catch((e) => log(`Could not write audit row: ${logLine(e)}`));
    return { status: "error", ...failure };
  }
}
