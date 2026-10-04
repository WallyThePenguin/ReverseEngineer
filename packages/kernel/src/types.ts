// The shapes every module is built from: actions (hands), events (senses), knowledge and
// reflexes. Together they are the Jarvis contract (PLAN.md section 6.1).
import type { Origin, PrincipalKind, Risk, Via } from "@hearth/core";
import type { Db, TurnLane, TurnTrigger, Tx } from "@hearth/db";
import type { z } from "zod";

/** Who is calling, and where the request ultimately came from. */
export interface Caller {
  principal: string;
  kind: PrincipalKind;
  origin: Origin;
  via: Via;
  correlationId?: string;
  /** The event that led to this call, if any. */
  causationId?: string;
  turnId?: string;
  conversationId?: string;
  /**
   * Set by Jarvis's runtime when this particular call needs your yes whatever its risk, e.g.
   * opening an address an untrusted turn never saw (D25). The text is the approval's reason.
   */
  askFirst?: string;
}

export interface EmitEvent {
  kind: string;
  entityId?: string | null;
  payload?: Record<string, unknown>;
}

export interface HearthEvent {
  seq: number;
  id: string;
  at: Date;
  kind: string;
  entityId: string | null;
  actor: string;
  origin: Origin;
  payload: Record<string, unknown>;
  correlationId: string | null;
  causationId: string | null;
}

export interface ActionContext {
  tx: Tx;
  caller: Caller;
  now: Date;
  correlationId: string;
  /** Buffers an event; events are appended when the action's transaction commits. */
  emit(event: EmitEvent): void;
  /** Calls another action in the same transaction, as the same caller, under the same policy. */
  call<T = unknown>(name: string, input: unknown): Promise<T>;
  /** A process-level service, like the browser. Throws "unavailable" if this process has none. */
  service<T>(name: string): T;
}

export interface ActionDef<S extends z.ZodType = z.ZodType, R = unknown> {
  /** "module.verb", e.g. "task.create". */
  name: string;
  /** What it does, written for Jarvis and MCP clients as much as for people. */
  description: string;
  input: S;
  risk: Risk;
  /** Which kinds of principals may call it at all. Defaults to everyone. */
  callers?: PrincipalKind[];
  /**
   * Its result is content from outside Hearth (a web page). Reading it makes the rest of Jarvis's
   * turn untrusted (D25).
   */
  external?: boolean;
  /** The web address this call would open, so an untrusted turn can be held to D25. */
  opensUrl?(input: z.output<S>): string | null;
  /**
   * Pins a call to the page it acts on before it runs or waits for your yes: the page's address,
   * so a turn that read outside content is held to D30, and anything to add to the input so the
   * call refuses to run if the page changed by the time it's approved.
   */
  pin?(
    input: z.output<S>,
    services: { service<T>(name: string): T },
  ): Promise<{ url: string; extra?: Record<string, unknown> } | null>;
  /**
   * What the call will do, captured from the records it acts on before it runs or waits for your
   * yes (an email's recipients and text). It's added to the input, so the approval card shows it
   * and the call refuses to run if the records changed by the time you say yes.
   */
  snapshot?(input: z.output<S>, ctx: ReadContext): Promise<Record<string, unknown>>;
  /** One line for an approval card: "Send email to Ana: Friday's agenda". */
  summarize?(input: z.output<S>): string;
  /**
   * Whether a call that worked gets its audit row, judged by its result. For a check-in that
   * mostly changes nothing (system.report, every minute per component), only the calls that
   * changed something are kept. Failures, refusals and approved calls are always kept.
   */
  auditWhen?(result: R): boolean;
  handler(input: z.output<S>, ctx: ActionContext): Promise<R>;
}

/**
 * A picture for Jarvis to look at, like a screenshot. An action returns these under the
 * `modelImages` key of its result; Jarvis's tools pass them to the model as images.
 */
export interface ModelImage {
  mimeType: "image/jpeg" | "image/png";
  /** Base64. */
  data: string;
}

export function defineAction<S extends z.ZodType, R>(def: ActionDef<S, R>): ActionDef<S, R> {
  return def;
}

export interface EventDef {
  kind: string;
  description: string;
}

/** A read-only view Jarvis's knowledge functions and reflexes get. */
export interface ReadContext {
  db: Db;
  now: Date;
}

/** Describes one record of a module's entity type as markdown, for Jarvis to read and cite. */
export type Describe = (entityId: string, ctx: ReadContext) => Promise<string | null>;

export interface NewNotification {
  kind: string;
  title: string;
  body?: string | null;
  entityId?: string | null;
  approvalId?: string | null;
  urgency?: "interrupt" | "normal" | "quiet";
  lane?: "signal" | "noise";
  deadline?: Date | null;
  dedupeKey?: string | null;
}

export interface NewObservation {
  kind: "finding" | "risk" | "followup" | "fyi";
  text: string;
  aboutId?: string | null;
  expiresAt?: Date | null;
}

/** What a reflex decides, cheapest first. Only "turn" spends a model turn. */
export type ReflexOutcome =
  | {
      kind: "turn";
      trigger: TurnTrigger;
      lane: TurnLane;
      prompt: string;
      subjectId?: string | null;
      conversationId?: string | null;
      dedupeKey?: string;
      context?: Record<string, unknown>;
      notBefore?: Date;
      /** What to do instead when the turn can't be spent (Jarvis paused or over budget). */
      fallback?: ReflexOutcome[];
      /** The prompt carries outside content, so the turn starts untrusted (D25). */
      untrusted?: boolean;
    }
  | { kind: "tell"; notification: NewNotification }
  | { kind: "note"; observation: NewObservation }
  | { kind: "act"; action: string; input: unknown }
  | { kind: "batch"; text: string; aboutId?: string | null }
  /**
   * Look again later. Calling this again with the same key moves the check, which debounces:
   * a note edited ten times gets one check, ten minutes after the last edit.
   */
  | { kind: "check_later"; key: string; at: Date; payload: Record<string, unknown> };

/**
 * - reactive: answers you (chat, @mentions, assignments, approvals, watches you set up).
 * - proactive: Jarvis's own initiative. Stops while Jarvis is paused and counts against the
 *   daily turn budget.
 * - always: deterministic reminders and alerts (a deadline, a failed backup). Never paused and
 *   never spends a model turn.
 */
export type ReflexMode = "reactive" | "proactive" | "always";

export interface ReflexDef {
  name: string;
  /** Plain words, shown in settings as "what Jarvis watches for". */
  description: string;
  /** Reactive reflexes answer you and keep working while Jarvis is paused; proactive ones stop. */
  mode: ReflexMode;
  /** Event kinds to react to; "*" means every event. */
  on: string[];
  /** Jarvis's own events are skipped unless this is set, so it can't loop on itself. */
  includeJarvisEvents?: boolean;
  run(event: HearthEvent, ctx: ReadContext): Promise<ReflexOutcome[]> | ReflexOutcome[];
  /** Runs when a check this reflex asked for (check_later) comes due. */
  onCheck?(
    payload: Record<string, unknown>,
    ctx: ReadContext & { event: HearthEvent },
  ): Promise<ReflexOutcome[]>;
}

/** One module's contribution to the brief, sorted into the brief's order. */
export interface DigestItem {
  bucket: "handled" | "prepared" | "needs_yes" | "today" | "fyi";
  text: string;
  entityId?: string | null;
  /** The text quotes something from outside Hearth (an email's subject). See isOutside. */
  outside?: boolean;
}

export interface DigestSection {
  module: string;
  items: DigestItem[];
}

export interface RoutineFiring {
  scheduledFor: Date;
  event: HearthEvent;
  /** Every module's digest since a time, gathered by the engine. */
  digest(since: Date): Promise<DigestSection[]>;
}

/** Work that runs on a schedule (the brief, prep, sweeps). Fired by the scheduler as clock.fired. */
export interface RoutineDef {
  name: string;
  description: string;
  cron: string;
  /** Skip a missed firing older than this, instead of running it late. */
  staleAfterSeconds: number | null;
  run(firing: RoutineFiring, ctx: ReadContext): Promise<ReflexOutcome[]>;
}

export interface HearthModule {
  name: string;
  description: string;
  entityTypes: string[];
  /**
   * Entity types whose records hold content from outside Hearth (a watched web page). Reading
   * one makes the rest of Jarvis's turn untrusted (D25).
   */
  outsideTypes?: string[];
  events: EventDef[];
  /** Kernel events this module's actions produce (entity.*, link.*, notification.*...). */
  kernelEvents?: string[];
  // Method-style members are bivariant, so actions with specific schemas fit here.
  actions: ActionDef[];
  knowledge: Record<string, Describe>;
  reflexes: ReflexDef[];
  routines?: RoutineDef[];
  /** What's notable in this module for the brief, the heartbeat and the journal. */
  digest?(ctx: ReadContext & { since: Date }): Promise<DigestItem[]>;
  /** If a module has nothing for Jarvis to react to yet, it must say why. */
  noReflexesBecause?: string;
}

export function defineModule(module: HearthModule): HearthModule {
  return module;
}
