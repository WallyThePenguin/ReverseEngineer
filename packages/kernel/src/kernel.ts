// The executor: every action from every surface runs through here, gets a policy decision,
// an audit row and its events (PLAN.md section 5.4).
import { type Db, principal, standingRule, type Tx } from "@hearth/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requestApproval, resolveApproval } from "./approvals.ts";
import { isAudited, writeAudit } from "./audit.ts";
import { type Clock, systemClock } from "./clock.ts";
import {
  ActionError,
  type ActionErrorCode,
  describeError,
  isDatabaseDown,
  logLine,
  stackFrames,
} from "./errors.ts";
import { appendEvents } from "./events.ts";
import { guardAgentCall, isGuarded, withoutGiven } from "./guard.ts";
import { newId } from "./ids.ts";
import { type RunHooks, runIo } from "./io.ts";
import { decide } from "./policy.ts";
import type { Registry } from "./registry.ts";
import type { ActionContext, ActionDef, Caller, EmitEvent } from "./types.ts";

export type ExecuteResult<R = unknown> =
  | { status: "ok"; result: R }
  | { status: "pending_approval"; approvalId: string; summary: string; reason: string }
  | { status: "denied"; reason: string }
  | { status: "error"; code: ActionErrorCode; message: string };

export interface KernelOptions {
  db: Db;
  registry: Registry;
  clock?: Clock;
  log?: (msg: string, err?: unknown) => void;
  /** Process-level services actions can use, like the browser bridge. */
  services?: Record<string, unknown>;
}

export class Kernel {
  readonly db: Db;
  readonly registry: Registry;
  readonly clock: Clock;
  readonly services: Record<string, unknown>;
  private readonly log: (msg: string, err?: unknown) => void;

  constructor(opts: KernelOptions) {
    this.db = opts.db;
    this.registry = opts.registry;
    this.clock = opts.clock ?? systemClock;
    this.services = opts.services ?? {};
    this.log = opts.log ?? ((msg, err) => console.error(msg, err));
  }

  async execute<R = unknown>(
    name: string,
    rawInput: unknown,
    caller: Caller,
  ): Promise<ExecuteResult<R>> {
    try {
      return await this.decideAndRun<R>(name, rawInput, caller);
    } catch (err) {
      // Failed before the action itself ran: checking a standing rule, asking for approval.
      this.log(`Action ${name} couldn't start: ${logLine(err)}`);
      return { status: "error", ...describeError(err) };
    }
  }

  private async decideAndRun<R>(
    name: string,
    rawInput: unknown,
    caller: Caller,
  ): Promise<ExecuteResult<R>> {
    const def = this.registry.action(name);
    if (!def)
      return { status: "error", code: "unknown_action", message: `No action named ${name}` };
    // Calls made as Jarvis are checked against the page they open or act on, and capture what
    // they'll do, before they run or wait for your yes (D25, D30, D58).
    const guarded = caller.kind === "agent" && isGuarded(def);
    const raw = guarded ? withoutGiven(def, rawInput ?? {}) : (rawInput ?? {});
    const parsed = def.input.safeParse(raw);
    if (!parsed.success) {
      return { status: "error", code: "invalid_input", message: z.prettifyError(parsed.error) };
    }
    let input: unknown = parsed.data;
    const correlationId = caller.correlationId ?? newId();
    if (guarded) {
      const g = await guardAgentCall(this, def, raw, input, caller);
      if (g.kind === "invalid")
        return {
          status: "error",
          ...(g.error instanceof z.ZodError
            ? { code: "invalid_input" as const, message: z.prettifyError(g.error) }
            : describeError(g.error)),
        };
      if (g.kind === "blocked") return this.refuse(def, caller, input, g.reason, correlationId);
      input = g.input;
      if (g.askFirst) caller = { ...caller, askFirst: caller.askFirst ?? g.askFirst };
    }
    const decision = decide(def, caller, await this.hasStandingRule(def.name, caller));
    if (decision.kind === "deny")
      return this.refuse(def, caller, input, decision.reason, correlationId);
    if (decision.kind === "ask") {
      const approval = await requestApproval(
        this,
        def,
        input,
        { ...caller, correlationId },
        decision.reason,
      );
      return {
        status: "pending_approval",
        approvalId: approval.id,
        summary: approval.summary,
        reason: decision.reason,
      };
    }
    return this.run<R>(def, input, { ...caller, correlationId });
  }

  private async refuse(
    def: ActionDef,
    caller: Caller,
    input: unknown,
    reason: string,
    correlationId: string,
  ): Promise<{ status: "denied"; reason: string }> {
    await writeAudit(this.db, {
      def,
      caller,
      input,
      outcome: "denied",
      error: reason,
      durationMs: 0,
      correlationId,
      at: this.clock.now(),
    });
    return { status: "denied", reason };
  }

  /** Approve or deny a pending approval. Only you can. */
  decideApproval(
    approvalId: string,
    decision: "approve" | "deny",
    caller: Caller,
  ): Promise<ExecuteResult> {
    return resolveApproval(this, approvalId, decision, caller);
  }

  /**
   * Runs an allowed action in its own transaction. Your own reads skip the audit row, so their
   * transaction writes nothing: Postgres gives it no transaction id and its commit flushes
   * nothing to disk. It isn't forced READ ONLY because a few reads record what they did as
   * events (browser.open), and those must still commit with them (D56).
   */
  async run<R>(
    def: ActionDef,
    input: unknown,
    caller: Caller & { correlationId: string },
    hooks: RunHooks = {},
  ): Promise<ExecuteResult<R>> {
    // Actions that wait on the world hold no transaction while they wait (io.ts, B1).
    if (def.io) return runIo<R>(this, def, input, caller, hooks, (m) => this.log(m));
    const started = performance.now();
    const now = this.clock.now();
    const audited = isAudited(def, caller) || hooks.approvalId !== undefined;
    try {
      const result = await this.db.transaction(async (tx) => {
        const buffered: EmitEvent[] = [];
        const ctx = this.context(tx, caller, now, buffered);
        const r = await def.handler(input, ctx);
        if (audited && (hooks.approvalId !== undefined || (def.auditWhen?.(r) ?? true))) {
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
        }
        // The approval closes before the event log's lock is taken: that lock comes last, so a
        // concurrent write to the approval's inbox card can't wait on it while holding the card.
        const after = hooks.inTx ? await hooks.inTx(tx, r) : null;
        await appendEvents(tx, buffered, {
          actor: caller.principal,
          origin: caller.origin,
          correlationId: caller.correlationId,
          causationId: caller.causationId ?? null,
          at: now,
        });
        if (after) await appendEvents(tx, after.events, after.stamp);
        return r as R;
      });
      return { status: "ok", result };
    } catch (err) {
      const failure = describeError(err);
      // A bug in a handler keeps where it happened; the database being out of reach doesn't need
      // a stack for every call that found it so.
      if (!(err instanceof ActionError)) {
        const where = isDatabaseDown(err) ? "" : stackFrames(err);
        this.log(`Action ${def.name} failed: ${logLine(err)}${where}`);
      }
      await writeAudit(this.db, {
        def,
        caller,
        input,
        outcome: "error",
        error: failure.message,
        durationMs: performance.now() - started,
        correlationId: caller.correlationId,
        approvalId: hooks.approvalId ?? null,
        at: now,
      }).catch((e) => this.log(`Could not write audit row: ${logLine(e)}`));
      return { status: "error", ...failure };
    }
  }

  /** Builds the context a handler runs with. Exposed for approvals and tests. */
  context(
    tx: Tx,
    caller: Caller & { correlationId: string },
    now: Date,
    buffered: EmitEvent[],
  ): ActionContext {
    const ctx: ActionContext = {
      tx,
      caller,
      now,
      correlationId: caller.correlationId,
      emit: (e) => {
        if (!this.registry.hasEvent(e.kind))
          throw new Error(`Event kind ${e.kind} is not declared by any module`);
        buffered.push(e);
      },
      service: <T>(name: string): T => {
        const s = this.services[name];
        if (!s)
          throw new ActionError("unavailable", `The ${name} isn't available in this process.`);
        return s as T;
      },
      call: async <T>(name: string, rawInput: unknown): Promise<T> => {
        const def = this.registry.action(name);
        if (!def) throw new ActionError("unknown_action", `No action named ${name}`);
        // A page to open or act on, or a send to show you, is checked as a call of its own (D58).
        if (caller.kind === "agent" && isGuarded(def))
          throw new ActionError("forbidden", `${name} runs only as a step of its own.`);
        const parsed = def.input.safeParse(rawInput ?? {});
        if (!parsed.success) throw new ActionError("invalid_input", z.prettifyError(parsed.error));
        const d = decide(def, caller, await this.hasStandingRule(def.name, caller, tx));
        if (d.kind !== "allow") throw new ActionError("forbidden", `${name}: ${d.reason}`);
        const started = performance.now();
        const result = (await def.handler(parsed.data, ctx)) as T;
        if (isAudited(def, caller) && (def.auditWhen?.(result) ?? true)) {
          await writeAudit(tx, {
            def,
            caller,
            input: parsed.data,
            outcome: "ok",
            durationMs: performance.now() - started,
            correlationId: caller.correlationId,
            at: now,
          });
        }
        return result;
      },
    };
    return ctx;
  }

  async hasStandingRule(action: string, caller: Caller, db: Db | Tx = this.db): Promise<boolean> {
    if (caller.kind !== "agent") return false;
    const rows = await db
      .select({ id: standingRule.id })
      .from(standingRule)
      .where(and(eq(standingRule.action, action), eq(standingRule.principal, caller.principal)));
    return rows.length > 0;
  }

  async principalKind(id: string, db: Db | Tx = this.db): Promise<Caller["kind"]> {
    const [row] = await db
      .select({ kind: principal.kind })
      .from(principal)
      .where(eq(principal.id, id));
    if (!row) throw new Error(`Unknown principal ${id}`);
    return row.kind;
  }
}
