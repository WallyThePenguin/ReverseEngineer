// Today's sums, apart from how it looks: the line under the greeting, the drafts it offers, what's
// due, what's on today, and what Jarvis did since yesterday. What needs your yes is needsYou.ts.

import { plural } from "./format.ts";
import { toolSentence } from "./toolNames.ts";
import type { CalEvent, MailAddress, MailDraft, MailThread, Task, Turn } from "./types.ts";
import { readWhen, type When } from "./when.ts";

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

/**
 * What the Ask box offers to add as a task: a line that names a time ("dentist fri 3pm"). A
 * question is for Jarvis, even when it names a day ("what's on friday?"). Enter always asks Jarvis;
 * the task is one more tap.
 */
export function offerAsTask(text: string, now = new Date()): When | null {
  const q = text.trim();
  return q && !q.endsWith("?") ? readWhen(q, now) : null;
}

/** A part of the line under the greeting, and the section it takes you to. */
export interface SummaryPart {
  text: string;
  /** The id of the section it's about. */
  to: string;
}

/**
 * The line under the greeting, "3 need your yes · 2 ready to send · 2 meetings · 4 tasks due",
 * each part counting what its section shows, or "Nothing needs you". A count that isn't known yet
 * (null: still being read, or it couldn't be) is left out, and "Nothing needs you" waits for both.
 */
export function summary(n: {
  approvals: number | null;
  ready: number | null;
  meetings: number;
  due: number;
}): SummaryPart[] {
  const parts: SummaryPart[] = [];
  if (n.approvals)
    parts.push({
      text: `${n.approvals} ${n.approvals === 1 ? "needs" : "need"} your yes`,
      to: "today-needs",
    });
  if (n.ready) parts.push({ text: `${n.ready} ready to send`, to: "today-drafts" });
  if (n.approvals === 0 && n.ready === 0)
    parts.push({ text: "Nothing needs you", to: "today-needs" });
  if (n.meetings) parts.push({ text: plural(n.meetings, "meeting"), to: "today-day" });
  if (n.due) parts.push({ text: `${plural(n.due, "task")} due`, to: "today-due" });
  return parts;
}

// --- Ready to send ---

/** The drafts Jarvis wrote, newest first, as Mail lists them. */
export const jarvisDrafts = (drafts: readonly MailDraft[] | undefined): MailDraft[] =>
  (drafts ?? []).filter((d) => d.by === "jarvis");

/**
 * The conversations waiting on your reply that still need you to write one: up to `shown` of
 * them, and how many more have a reply drafted (it's on Today already, ready to send or asked).
 */
export function owed(
  threads: readonly MailThread[] | undefined,
  drafted: ReadonlySet<string>,
  shown = 5,
): { rows: MailThread[]; drafted: number } {
  const all = threads ?? [];
  const rows = all.filter((t) => !drafted.has(t.id));
  return { rows: rows.slice(0, shown), drafted: all.length - rows.length };
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

// --- Your day ---

/**
 * An invitation you haven't answered (one you organized needs no answer). Only on a calendar of
 * your own: on a colleague's calendar shared with you, the one not answering is them.
 */
export const unanswered = (e: Pick<CalEvent, "selfResponse" | "selfOrganizer" | "ownCalendar">) =>
  e.ownCalendar && e.selfResponse === "needsAction" && !e.selfOrganizer;

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
 * on a day is late from the next day; one due at a time, from that time. Jarvis's own tasks are
 * left out, as the brief leaves them out of what's due (tasks/index.ts).
 */
export function splitDue(
  tasks: readonly Task[] | undefined,
  now = new Date(),
): { overdue: Task[]; today: Task[] } {
  const today = dayKey(now);
  const out = { overdue: [] as Task[], today: [] as Task[] };
  for (const t of tasks ?? []) {
    if (!t.dueAt || t.status === "completed" || t.status === "canceled") continue;
    if (t.assignee === "jarvis") continue;
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
 * not the ones it skipped (while paused, say) or hasn't started, and not the ones that came to
 * nothing: a look round that found nothing to do, or one you stopped before it did or said a thing.
 */
export function sinceYesterday(turns: readonly Turn[] | undefined, now = new Date()): Turn[] {
  const from = startOfYesterday(now).getTime();
  return (turns ?? []).filter(
    (t) =>
      Date.parse(t.queuedAt) >= from &&
      t.status !== "skipped" &&
      t.status !== "queued" &&
      !cameToNothing(t),
  );
}

/** A turn that finished (or was stopped) having changed nothing and said nothing. */
const cameToNothing = (t: Turn) =>
  (t.outcome === "nothing" || t.status === "canceled") && t.writes === 0 && !t.reply?.trim();

/** What a turn used, in plain words, each once: ["Drafted an email", "Checked your calendar"]. */
export const toolsSaid = (tools: readonly string[]): string[] => [
  ...new Set(tools.map((n) => toolSentence(n, "done"))),
];
