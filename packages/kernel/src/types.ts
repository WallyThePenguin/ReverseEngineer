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
  /** One line for an approval card: "Send email to Ana: Friday's agenda". */
  summarize?(input: z.output<S>): string;
  handler(input: z.output<S>, ctx: ActionContext): Promise<R>;
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
    }
  | { kind: "tell"; notification: NewNotification }
  | { kind: "note"; observation: NewObservation }
  | { kind: "act"; action: string; input: unknown }
  | { kind: "batch"; text: string; aboutId?: string | null }
  | { kind: "check_later"; id: string; at: Date; payload: Record<string, unknown> };

export type ReflexMode = "reactive" | "proactive";

export interface ReflexDef {
  name: string;
  /** Plain words, shown in settings as "what Jarvis watches for". */
  description: string;
  /** Reactive reflexes answer you and keep working while Jarvis is paused; proactive ones stop. */
  mode: ReflexMode;
  on: string[];
  /** Jarvis's own events are skipped unless this is set, so it can't loop on itself. */
  includeJarvisEvents?: boolean;
  run(event: HearthEvent, ctx: ReadContext): Promise<ReflexOutcome[]> | ReflexOutcome[];
}

/** Work that runs on a schedule (the brief, prep, sweeps). Fired by the scheduler as clock.fired. */
export interface RoutineDef {
  name: string;
  description: string;
  cron: string;
  /** Skip a missed firing older than this, instead of running it late. */
  staleAfterSeconds: number | null;
  run(
    firing: { scheduledFor: Date; event: HearthEvent },
    ctx: ReadContext,
  ): Promise<ReflexOutcome[]>;
}

export interface HearthModule {
  name: string;
  description: string;
  entityTypes: string[];
  events: EventDef[];
  // Method-style members are bivariant, so actions with specific schemas fit here.
  actions: ActionDef[];
  knowledge: Record<string, Describe>;
  reflexes: ReflexDef[];
  routines?: RoutineDef[];
  /** If a module has nothing for Jarvis to react to yet, it must say why. */
  noReflexesBecause?: string;
}

export function defineModule(module: HearthModule): HearthModule {
  return module;
}
