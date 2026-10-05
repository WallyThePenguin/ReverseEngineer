// Today's sums, apart from how it looks: which approvals go together and what "Approve all" says
// it did, who a draft would reach that isn't in its conversation yet, what's due, what's on today,
// and what Jarvis did since yesterday.

import type { Decided } from "./approvals.ts";
import { plural, who } from "./format.ts";
import { approvalParts, summaryParts } from "./inbox.ts";
import { toolSentence } from "./toolNames.ts";
import type {
  Approval,
  CalEvent,
  InboxRow,
  MailAddress,
  MailDraft,
  MailThreadView,
  Task,
  Turn,
} from "./types.ts";

const DAY = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** A day where you are, as a number that sorts: 20261005. */
const dayKey = (d: Date) => d.getFullYear() * 10_000 + (d.getMonth() + 1) * 100 + d.getDate();

/** "Good morning", "Good afternoon" or "Good evening", by the clock where you are. */
export function greeting(now = new Date()): string {
  const h = now.getHours();
  if (h >= 5 && h < 12) return "Good morning";
  if (h >= 12 && h < 18) return "Good afternoon";
  return "Good evening";
}

/** The line under the greeting: "3 things need you · 2 meetings · 4 tasks due". */
export function summary(n: { needs: number; meetings: number; due: number }): string {
  const parts = [
    n.needs
      ? `${plural(n.needs, "thing")} ${n.needs === 1 ? "needs" : "need"} you`
      : "Nothing needs you",
  ];
  if (n.meetings) parts.push(plural(n.meetings, "meeting"));
  if (n.due) parts.push(`${plural(n.due, "task")} due`);
  return parts.join(" · ");
}

// --- Needs you ---

/** Approvals that ask for the same kind of thing, where the first of them was asked. */
export interface ApprovalGroup {
  action: string;
  items: Approval[];
}

export function groupApprovals(list: readonly Approval[] | undefined): ApprovalGroup[] {
  const groups = new Map<string, Approval[]>();
  for (const a of list ?? []) groups.set(a.action, [...(groups.get(a.action) ?? []), a]);
  return [...groups].map(([action, items]) => ({ action, items }));
}

/**
 * An approval as its card shows it: as the inbox has it when it's there (its title names records
 * by their titles, and says who asks), and otherwise from the approval itself.
 */
export function approvalCard(
  a: Approval,
  row: InboxRow | undefined,
): { what: string; why: string | null; text: string | null } {
  if (row) return approvalParts(row.notification);
  const parts = summaryParts(a.summary);
  return {
    what: `${who(a.requestedBy)} asks: ${parts.what ?? a.action}`,
    why: a.reason || null,
    text: parts.text,
  };
}

/**
 * What "Approve all" did, in a line: "3 approved." when all went through; otherwise how many did
 * and what became of the rest, and to look again: "2 approved, 1 changed — look again."
 */
export function approveAllMessage(outcomes: readonly Decided[]): { text: string; ok: boolean } {
  const count = (k: Decided) => outcomes.filter((o) => o === k).length;
  const [done, changed, failed] = [count("done"), count("changed"), count("failed")];
  const parts = [`${done} approved`];
  if (changed) parts.push(`${changed} changed`);
  if (failed) parts.push(`${failed} didn't go through`);
  const ok = changed + failed === 0;
  return { text: ok ? `${parts[0]}.` : `${parts.join(", ")} — look again.`, ok };
}

// --- Ready to send ---

/** The drafts Jarvis wrote, newest first, as Mail lists them. */
export const jarvisDrafts = (drafts: readonly MailDraft[] | undefined): MailDraft[] =>
  (drafts ?? []).filter((d) => d.by === "jarvis");

/** The drafts Jarvis already asked to send: they wait in Needs you, so they aren't offered twice. */
export function askedToSend(approvals: readonly Approval[] | undefined): Set<string> {
  const ids = new Set<string>();
  for (const a of approvals ?? []) {
    const id = (a.input as { id?: unknown } | null)?.id;
    if (a.action === "mail.send" && typeof id === "string") ids.add(id);
  }
  return ids;
}

/** An address as Hearth writes it in a send's snapshot: "ana@x.example (Ana Silva)". */
const shown = (a: MailAddress) => (a.name ? `${a.address} (${a.name})` : a.address);

/**
 * What Send says it's sending: the draft exactly as it's shown. Hearth sends it only if the draft
 * still matches (mail/send.ts), so one that changed since it was drawn here is refused.
 */
export function draftSnapshot(d: MailDraft) {
  return {
    from: d.account ?? "",
    to: d.to.map(shown),
    cc: d.cc.map(shown),
    bcc: d.bcc.map(shown),
    subject: d.subject,
    text: d.text,
  };
}

const key = (a: MailAddress) => a.address.trim().toLowerCase();

/** Everyone already in a conversation: you, whoever wrote in it, and whoever it went to. */
export function participantsOf(
  t: Pick<MailThreadView, "account" | "participants" | "messages">,
): Set<string> {
  const all = new Set([t.account.toLowerCase(), ...t.participants.map(key)]);
  for (const m of t.messages) for (const a of [m.from, ...m.to, ...m.cc]) all.add(key(a));
  return all;
}

/** A reply's recipients who aren't in its conversation yet: it would reach someone new. */
export function strangers(
  d: Pick<MailDraft, "to" | "cc" | "bcc">,
  inThread: ReadonlySet<string>,
): Set<string> {
  return new Set([...d.to, ...d.cc, ...d.bcc].map(key).filter((a) => !inThread.has(a)));
}

// --- Your day ---

/** An invitation you haven't answered (one you organized needs no answer). */
export const unanswered = (e: Pick<CalEvent, "selfResponse" | "selfOrganizer">) =>
  e.selfResponse === "needsAction" && !e.selfOrganizer;

/**
 * Today's meetings, all-day ones first and then by time (leaving out what you said no to), and the
 * invitations after today still waiting for your answer, soonest first.
 */
export function dayPlan(
  events: readonly CalEvent[] | undefined,
  now = new Date(),
): { today: CalEvent[]; invites: CalEvent[] } {
  const start = startOfDay(now).getTime();
  const end = start + DAY;
  const live = (events ?? []).filter((e) => e.status !== "cancelled");
  const at = (e: CalEvent) => Date.parse(e.startsAt);
  const today = live
    .filter((e) => at(e) < end && Date.parse(e.endsAt) > start && e.selfResponse !== "declined")
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || at(a) - at(b));
  const invites = live.filter((e) => at(e) >= end && unanswered(e)).sort((a, b) => at(a) - at(b));
  return { today, invites };
}

/** Where a meeting stands: over, on now, the next one, or later. */
export function meetingState(
  e: Pick<CalEvent, "startsAt" | "endsAt" | "allDay">,
  next: string | undefined,
  id: string,
  now = new Date(),
): "past" | "now" | "next" | "later" {
  if (e.allDay) return "later";
  if (Date.parse(e.endsAt) <= now.getTime()) return "past";
  if (Date.parse(e.startsAt) <= now.getTime()) return "now";
  return id === next ? "next" : "later";
}

/** The first of today's timed meetings that hasn't started yet. */
export const nextMeeting = (today: readonly CalEvent[], now = new Date()) =>
  today.find((e) => !e.allDay && Date.parse(e.startsAt) > now.getTime())?.id;

// --- Due ---

/**
 * Open tasks due by the end of today: the late ones and today's, each soonest first. A task due
 * on a day is late from the next day; one due at a time, from that time.
 */
export function splitDue(
  tasks: readonly Task[] | undefined,
  now = new Date(),
): { overdue: Task[]; today: Task[] } {
  const today = dayKey(now);
  const out = { overdue: [] as Task[], today: [] as Task[] };
  for (const t of tasks ?? []) {
    if (!t.dueAt || t.status === "completed" || t.status === "canceled") continue;
    const due = new Date(t.dueAt);
    const late = t.dueIsDate ? dayKey(due) < today : due.getTime() < now.getTime();
    if (late) out.overdue.push(t);
    else if (dayKey(due) === today) out.today.push(t);
  }
  const soonest = (a: Task, b: Task) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!);
  out.overdue.sort(soonest);
  out.today.sort(soonest);
  return out;
}

/** The end of today where you are, which task.list's dueBefore reads up to. */
export const endOfToday = (now = new Date()) => new Date(startOfDay(now).getTime() + DAY - 1);

// --- What Jarvis did ---

/** The start of yesterday, where you are. */
export const startOfYesterday = (now = new Date()) =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

/**
 * What Jarvis did since the start of yesterday, newest first: the turns that ran or are running,
 * not the ones it skipped (while paused, say) or hasn't started.
 */
export function sinceYesterday(turns: readonly Turn[] | undefined, now = new Date()): Turn[] {
  const from = startOfYesterday(now).getTime();
  return (turns ?? []).filter(
    (t) => Date.parse(t.queuedAt) >= from && t.status !== "skipped" && t.status !== "queued",
  );
}

/** A turn in a line: the first line of its reply, without markdown's marks. */
export function replyLine(t: Pick<Turn, "reply" | "status">): string {
  const line = (t.reply ?? "")
    .split("\n")
    .map((l) =>
      l
        .replace(/^\s*(?:#+|[-*>]|\d+\.)\s*/, "")
        .replace(/[*_`]/g, "")
        .trim(),
    )
    .find(Boolean);
  if (line) return line;
  if (t.status === "running") return "Working on it…";
  if (t.status === "failed") return "It hit a problem and stopped.";
  return "Done, with nothing to say.";
}

/** What a turn used, in plain words, each once: ["Drafted an email", "Checked your calendar"]. */
export const toolsSaid = (tools: readonly string[]): string[] => [
  ...new Set(tools.map((n) => toolSentence(n, "done"))),
];
