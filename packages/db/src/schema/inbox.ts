// The inbox, approvals, standing rules and the audit log. Mirrors migrations/*.sql.
import { bigint, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** A yes is "executing" while it runs: claimed first, so a second yes can't run it again (D58). */
export type ApprovalStatus = "pending" | "executing" | "denied" | "executed" | "failed" | "expired";

export const approval = pgTable("approval", {
  id: uuid("id").primaryKey(),
  action: text("action").notNull(),
  input: jsonb("input").notNull(),
  inputHash: text("input_hash").notNull(),
  risk: text("risk").notNull(),
  summary: text("summary").notNull(),
  reason: text("reason").notNull(),
  requestedBy: text("requested_by").notNull(),
  origin: text("origin").notNull(),
  status: text("status").$type<ApprovalStatus>().notNull().default("pending"),
  decidedBy: text("decided_by"),
  decidedAt: ts("decided_at"),
  result: jsonb("result"),
  error: text("error"),
  turnId: uuid("turn_id"),
  conversationId: uuid("conversation_id"),
  correlationId: uuid("correlation_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at"),
  /** What Always allow would cover, set when it's asked; null when it can't offer one (D70). */
  alwaysAllow: jsonb("always_allow").$type<AlwaysAllow>(),
});

/** An Always allow: the one place or person a rule reaches, and its words ("posting in #eng"). */
export interface AlwaysAllow {
  target: string;
  says: string;
}

export const standingRule = pgTable("standing_rule", {
  id: uuid("id").primaryKey(),
  action: text("action").notNull(),
  principal: text("principal").notNull(),
  /** The one place or person it covers (a channel, a person), or '' for the whole action (D70). */
  target: text("target").notNull().default(""),
  note: text("note").notNull().default(""),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export type NotificationState = "unseen" | "seen" | "done";
export type NotificationUrgency = "interrupt" | "normal" | "quiet";

export const notification = pgTable("notification", {
  id: uuid("id").primaryKey(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  entityId: uuid("entity_id"),
  approvalId: uuid("approval_id"),
  state: text("state").$type<NotificationState>().notNull().default("unseen"),
  lane: text("lane").$type<"signal" | "noise">().notNull().default("signal"),
  urgency: text("urgency").$type<NotificationUrgency>().notNull().default("normal"),
  deadline: ts("deadline"),
  deliveredAt: ts("delivered_at"),
  deferredReason: text("deferred_reason"),
  snoozedUntil: ts("snoozed_until"),
  dedupeKey: text("dedupe_key").unique(),
  sourceEventSeq: bigint("source_event_seq", { mode: "number" }),
  createdBy: text("created_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const audit = pgTable("audit", {
  id: uuid("id").primaryKey(),
  at: ts("at").notNull().defaultNow(),
  principal: text("principal").notNull(),
  origin: text("origin").notNull(),
  via: text("via").notNull(),
  action: text("action").notNull(),
  risk: text("risk").notNull(),
  input: jsonb("input"),
  outcome: text("outcome").$type<"ok" | "error" | "pending_approval" | "denied">().notNull(),
  error: text("error"),
  durationMs: integer("duration_ms").notNull().default(0),
  correlationId: uuid("correlation_id"),
  approvalId: uuid("approval_id"),
});
