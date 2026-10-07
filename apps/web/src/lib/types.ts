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
  /** Written after reading outside content (an email, a web page), so it may quote it (D58). */
  outside?: boolean;
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
  status: "pending" | "executing" | "denied" | "executed" | "failed" | "expired";
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
  /** "slack_member" for a Slack member's conversation with Jarvis (D62). */
  startedVia: string | null;
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
  /**
   * What it was asked with: via "slack" for your DM with Jarvis there (D62), and `readOutside`
   * once it read outside content on the way.
   */
  context?: ({ readOutside?: boolean } & Record<string, unknown>) | null;
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
  /** What's connected so far, for the "Set up Hearth" checklist (absent from older servers). */
  setup?: { google: boolean; chrome: boolean; phone: boolean; desktop: boolean };
  jarvisPaused: boolean;
  /** When the Jarvis process last checked in; null before it ever has. */
  jarvisAlive: { at: string; since: string; pid: number } | null;
  components: Record<string, { status: "ok" | "degraded" | "failing"; detail: string; at: string }>;
  /** Hearth's own schedules, soonest first; reminders have their own list (reminder.list). */
  schedules: { id: string; nextRunAt: string | null }[];
}

/** A reminder still to ring, as reminder.list gives it. */
export interface Reminder {
  id: string;
  /** Its words; wrapped as outside content when set after reading an email or a message. */
  text: string;
  at: string;
  /** When, in your time zone: "Thu 2026-10-08, 3:00 p.m.". */
  when: string;
  setAfterOutsideContent: boolean;
  /** You asked for it, in a conversation that had read an email or a message. */
  asked?: boolean;
}

export interface LastContact {
  at: string;
  kind: "email" | "meeting";
}

export interface Person {
  id: string;
  name: string;
  company: string | null;
  lastContact: LastContact | null;
  followUpDays: number | null;
  overdueDays: number | null;
}

export interface Linked {
  id: string;
  type: string;
  title: string;
  at: string;
}

export interface PersonDetail {
  id: string;
  name: string;
  notes: string;
  emails: string[];
  company: { id: string; name: string; domain: string } | null;
  followUpDays: number | null;
  overdueDays: number | null;
  fields: Record<string, string>;
  lastContact: LastContact | null;
  threads: (Linked & { messages: number })[];
  upcoming: Linked[];
  met: Linked[];
  items: Linked[];
}

export interface Company {
  id: string;
  name: string;
  domain: string;
  people: number;
}

export interface CompanyDetail {
  id: string;
  name: string;
  domain: string;
  notes: string;
  people: Person[];
}

export interface StandingRule {
  id: string;
  action: string;
  principal: string;
  note: string;
  createdAt: string;
}

export interface PageWatch {
  id: string;
  title: string;
  url: string;
  mode: "browser" | "fetch";
  selector: string | null;
  everyMinutes: number;
  onChange: string | null;
  active: boolean;
  status: "new" | "ok" | "waiting" | "failing";
  lastCheckedAt: string | null;
  lastChangedAt: string | null;
  lastError: string | null;
  /** Only from page_watch.get. */
  lastText?: string | null;
  previousText?: string | null;
}

export interface MemoryNote {
  id: string;
  title: string;
  /** Not in memory.list. */
  body: string;
  scope: "always" | "topic";
  keywords: string[];
  revision: number;
  updatedAt: string;
  updatedBy: string;
}

export interface MemoryRevision {
  entityId: string;
  revision: number;
  title: string;
  body: string;
  scope: "always" | "topic";
  keywords: string[];
  reason: string | null;
  changedBy: string;
  at: string;
}

export interface CalEvent {
  id: string;
  title: string;
  description: string;
  calendarId: string;
  status: "confirmed" | "tentative" | "cancelled";
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  location: string | null;
  meetUrl: string | null;
  htmlLink: string | null;
  selfResponse: string | null;
  /** You made it, so there's nothing to answer. */
  selfOrganizer: boolean;
  /**
   * On a calendar of your own. On one someone shared with you, Google's "you" is its owner: its
   * selfResponse is theirs, and answering it would answer as them.
   */
  ownCalendar: boolean;
  /** One time of a repeating meeting: answering it asks whether for this time or every time. */
  recurringEventId: string | null;
  attendees: { email: string; name?: string; response?: string; self?: boolean }[];
  taskId: string | null;
  /** Its prep packet's record, once Jarvis has written one. */
  prepId?: string;
}

/** One thing Jarvis made (jarvis.did): read from the record itself, never from what it said. */
export interface Did {
  at: string;
  /** "Drafted a reply: Re: Lease", "Made a task: Call the plumber". */
  text: string;
  entityId: string;
  entityType: string;
  /** The turn that made it, when one did. */
  turnId?: string;
  /** Written after reading outside content (D58). */
  outside?: boolean;
}

export type * from "./integration-types.ts";
