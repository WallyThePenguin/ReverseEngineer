// Jarvis's spine: conversations, turns, observations, schedules and watches.
// Mirrors migrations/*.sql.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

type Origin = "owner" | "agent" | "untrusted" | "system";

export const conversation = pgTable("conversation", {
  entityId: uuid("entity_id").primaryKey(),
  subjectId: uuid("subject_id"),
  agentSessionId: text("agent_session_id"),
  lastTurnAt: ts("last_turn_at"),
  /** "device" when the desktop app started it; a device can only read its own conversations. */
  startedVia: text("started_via"),
  /** When a turn here first read outside content: later turns start untrusted (D58). */
  taintedAt: ts("tainted_at"),
  /** What it read, in a few words, for the badge that explains why Jarvis asks more. */
  taintSource: text("taint_source"),
  /** Addresses that appeared in what it read (D25), and sites it opened before then (D30). */
  seenUrls: text("seen_urls").array().notNull().default(sql`'{}'`),
  vouchedHosts: text("vouched_hosts").array().notNull().default(sql`'{}'`),
});

export const conversationLog = pgTable(
  "conversation_log",
  {
    conversationId: uuid("conversation_id").notNull(),
    idx: integer("idx").notNull(),
    at: ts("at").notNull().defaultNow(),
    turnId: uuid("turn_id"),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.idx] })],
);

export type TurnTrigger =
  | "chat"
  | "mention"
  | "assignment"
  | "approval"
  | "watch"
  | "reflex"
  | "routine"
  | "voice_command";
export type TurnMode = "reactive" | "proactive";
export type TurnLane = "fast" | "deep";
export type TurnStatus = "queued" | "running" | "done" | "failed" | "skipped" | "canceled";
export type TurnOutcome = "act" | "ask" | "tell" | "note" | "nothing";

export const jarvisTurn = pgTable("jarvis_turn", {
  id: uuid("id").primaryKey(),
  trigger: text("trigger").$type<TurnTrigger>().notNull(),
  mode: text("mode").$type<TurnMode>().notNull(),
  lane: text("lane").$type<TurnLane>().notNull(),
  origin: text("origin").$type<Origin>().notNull(),
  prompt: text("prompt").notNull(),
  context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
  conversationId: uuid("conversation_id"),
  subjectId: uuid("subject_id"),
  sourceEventSeq: bigint("source_event_seq", { mode: "number" }),
  dedupeKey: text("dedupe_key").unique(),
  status: text("status").$type<TurnStatus>().notNull().default("queued"),
  skipReason: text("skip_reason"),
  outcome: text("outcome").$type<TurnOutcome>(),
  reply: text("reply"),
  toolsUsed: text("tools_used").array().notNull().default(sql`'{}'`),
  writes: integer("writes").notNull().default(0),
  error: text("error"),
  queuedAt: ts("queued_at").notNull().defaultNow(),
  notBefore: ts("not_before").notNull().defaultNow(),
  startedAt: ts("started_at"),
  finishedAt: ts("finished_at"),
  firstTokenMs: integer("first_token_ms"),
  durationMs: integer("duration_ms"),
  /** Model attempts started: a turn that hit a passing error is tried again (D54). */
  attempts: integer("attempts").notNull().default(0),
  /** What kind of error ended the last attempt (see packages/jarvis/src/failures.ts). */
  errorKind: text("error_kind"),
  /** A routine's plain version, published if the model never manages it (D54). */
  fallback: jsonb("fallback").$type<unknown[]>(),
  cancelRequestedAt: ts("cancel_requested_at"),
});

export const observation = pgTable("observation", {
  id: uuid("id").primaryKey(),
  kind: text("kind").$type<"finding" | "risk" | "followup" | "fyi">().notNull(),
  text: text("text").notNull(),
  aboutId: uuid("about_id"),
  supersedes: uuid("supersedes"),
  expiresAt: ts("expires_at"),
  surfacedAt: ts("surfaced_at"),
  createdBy: text("created_by").notNull(),
  turnId: uuid("turn_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
  /** The noting turn's origin: an untrusted turn's note is outside content (D58). */
  origin: text("origin").$type<Origin>().notNull().default("untrusted"),
});

export const heartbeatItem = pgTable("heartbeat_item", {
  id: uuid("id").primaryKey(),
  text: text("text").notNull(),
  aboutId: uuid("about_id"),
  sourceEventSeq: bigint("source_event_seq", { mode: "number" }),
  createdAt: ts("created_at").notNull().defaultNow(),
  takenAt: ts("taken_at"),
  /** The origin of the event that set it aside (D58). */
  origin: text("origin").$type<Origin>().notNull().default("untrusted"),
});

export const schedule = pgTable("schedule", {
  id: text("id").primaryKey(),
  kind: text("kind").$type<"routine" | "reminder" | "check">().notNull(),
  cron: text("cron"),
  timeZone: text("time_zone").notNull().default("America/New_York"),
  nextRunAt: ts("next_run_at"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  staleAfterSeconds: integer("stale_after_seconds"),
  enabled: boolean("enabled").notNull().default(true),
  lastRunAt: ts("last_run_at"),
  lastOutcome: text("last_outcome"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const watch = pgTable("watch", {
  id: uuid("id").primaryKey(),
  description: text("description").notNull(),
  filter: jsonb("filter").notNull(),
  subjectId: uuid("subject_id"),
  conversationId: uuid("conversation_id"),
  createdBy: text("created_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at"),
  lastMatchedAt: ts("last_matched_at"),
  endedAt: ts("ended_at"),
  /** Whoever set it up, as far as trust goes: its turns start no stronger than this (D58). */
  origin: text("origin").$type<Origin>().notNull().default("untrusted"),
});
