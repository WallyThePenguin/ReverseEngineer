// The shapes the server's actions return (see packages/modules).

export type TaskStatus = "not_started" | "in_progress" | "in_review" | "completed" | "canceled";
export type Priority = "none" | "low" | "medium" | "high" | "urgent";

export interface Entity {
  id: string;
  type: string;
  title: string;
  body: string | null;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  deletedAt: string | null;
  revision: number;
}

export interface Task {
  id: string;
  number: number;
  key: string;
  title: string;
  body: string;
  status: TaskStatus;
  priority: Priority;
  dueAt: string | null;
  dueIsDate: boolean;
  estimateMinutes: number | null;
  assignee: "owner" | "jarvis" | null;
  parentId: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  revision: number;
}

export interface NoteRow {
  id: string;
  title: string;
  preview: string;
  updatedAt: string;
}

export interface SearchHit {
  id: string;
  type: string;
  title: string;
  preview?: string;
  updatedAt: string;
}

export interface LinkRow {
  id: string;
  kind: string;
  anchor: string;
  otherId: string;
  otherType: string;
  otherTitle: string;
}

export interface Links {
  outgoing: LinkRow[];
  incoming: LinkRow[];
}

export interface Notification {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  entityId: string | null;
  approvalId: string | null;
  state: "unseen" | "seen" | "done";
  lane: "signal" | "noise";
  urgency: "interrupt" | "normal" | "quiet";
  deadline: string | null;
  snoozedUntil: string | null;
  createdBy: string;
  createdAt: string;
}

export interface InboxRow {
  notification: Notification;
  entityTitle: string | null;
  entityType: string | null;
  approvalStatus: string | null;
}

export interface Approval {
  id: string;
  action: string;
  input: unknown;
  risk: string;
  summary: string;
  reason: string;
  requestedBy: string;
  origin: string;
  status: "pending" | "denied" | "executed" | "failed" | "expired";
  error: string | null;
  conversationId: string | null;
  createdAt: string;
}

export interface ConversationRow {
  id: string;
  title: string;
  updatedAt: string;
  subjectId: string | null;
  lastTurnAt: string | null;
}

export interface LogRecord {
  idx: number;
  at: string;
  turnId: string | null;
  kind: string;
  payload: Record<string, unknown>;
}

export interface Turn {
  id: string;
  trigger: string;
  mode: string;
  lane: string;
  origin: string;
  prompt: string;
  conversationId: string | null;
  subjectId: string | null;
  status: string;
  skipReason: string | null;
  outcome: string | null;
  reply: string | null;
  toolsUsed: string[];
  writes: number;
  error: string | null;
  queuedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface Observation {
  id: string;
  kind: string;
  text: string;
  aboutId: string | null;
  createdAt: string;
}

export interface Watch {
  id: string;
  description: string;
  subjectId: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface SystemStatus {
  jarvisPaused: boolean;
  components: Record<string, { status: "ok" | "degraded" | "failing"; detail: string; at: string }>;
  schedules: { id: string; nextRunAt: string | null }[];
}

export interface Person {
  id: string;
  name: string;
  updatedAt: string;
}

export interface StandingRule {
  id: string;
  action: string;
  principal: string;
  note: string;
  createdAt: string;
}
