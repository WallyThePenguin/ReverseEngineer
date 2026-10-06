// Dates and labels the way you'd say them.

const DAY = 86_400_000;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function time(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  const suffix = h < 12 ? "a.m." : "p.m.";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour} ${suffix}` : `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "today", "tomorrow", "Fri", "Oct 14". */
export function day(d: Date, now = new Date()): string {
  const diff = Math.round((startOfDay(d) - startOfDay(now)) / DAY);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  if (diff > 1 && diff < 7) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * "Wed, Oct 7", with the year when it isn't this one: a day that stays right however long it
 * waits to be read, as an approval may. English, like the rest of Hearth's words.
 */
export function date(d: Date, now = new Date()): string {
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** "Wed, Oct 7, 4 p.m." */
export function dateTime(d: Date, now = new Date()): string {
  return `${date(d, now)}, ${time(d)}`;
}

/** "4 to 4:30 p.m.", "11:30 a.m. to 1 p.m.": a time to a time on the same day. */
export function hours(start: Date, end: Date): string {
  const from = time(start);
  const to = time(end);
  const sameHalf = from.slice(-4) === to.slice(-4);
  return `${sameHalf ? from.slice(0, -5) : from} to ${to}`;
}

/** "Wed, Oct 7, 4 to 4:30 p.m.", or "Wed, Oct 7, 4 p.m. to Thu, Oct 8, 9 a.m." across days. */
export function span(start: Date, end: Date, now = new Date()): string {
  return startOfDay(start) === startOfDay(end)
    ? `${date(start, now)}, ${hours(start, end)}`
    : `${dateTime(start, now)} to ${dateTime(end, now)}`;
}

/** A date-time as JSON writes it ("2026-10-07T16:00:00-04:00"), or a day ("2026-10-07"). */
const ISO = String.raw`\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?`;
/**
 * The only sentences whose times are put in words: the calendar's own, exactly as
 * calendar/actions.ts writes them. An event's times come last, after its quoted title, so a time
 * inside the title (or anywhere else) is never taken for them.
 */
const EVENT = [
  new RegExp(String.raw`(\bAdd ".*" )(${ISO}) to (${ISO})( to your calendar)$`),
  new RegExp(String.raw`(\bInvite .+ to ".*" )(${ISO}) to (${ISO})()$`),
];
const NEW_START = new RegExp(
  String.raw`(\bUpdate a meeting to start )(${ISO})((?: as ".*")?, telling its guests)$`,
);

function parseIso(s: string): Date | null {
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!ymd) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // A bare day is that day where you are, not midnight in London; and only a real day.
  const [y, m, day] = [Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])];
  const d = new Date(y, m, day);
  return d.getMonth() === m && d.getDate() === day ? d : null;
}

/** An event's start and end as you'd say them, or null to leave them as written. */
function eventTimes(a: string, b: string, now: Date): string | null {
  const start = parseIso(a);
  const end = parseIso(b);
  if (!start || !end) return null;
  const [timedStart, timedEnd] = [a.includes("T"), b.includes("T")];
  if (timedStart && timedEnd) return span(start, end, now);
  // A day with a time isn't an event Hearth makes, so it stays as written.
  if (timedStart || timedEnd) return null;
  // All day: the end is the day after the last day, as Google has it (calendar/actions.ts).
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1);
  if (last < start) return null;
  return last.getTime() === start.getTime()
    ? `${date(start, now)}, all day`
    : `${date(start, now)} to ${date(last, now)}`;
}

/**
 * The times in an approval's heading that the calendar wrote, the way you'd say them: `Invite
 * dana@… to "Offsite" 2026-10-07T16:00:00-04:00 to 2026-10-07T16:30:00-04:00` reads "… Wed,
 * Oct 7, 4 to 4:30 p.m.", in your own time zone, and a one-day `2026-10-07 to 2026-10-08` reads
 * "Wed, Oct 7, all day". Nothing else changes: a link, a file name, a title or any other date
 * shows exactly as written, since that's what will be used.
 */
export function humanTimes(text: string, now = new Date()): string {
  let out = text;
  for (const re of EVENT)
    out = out.replace(re, (all: string, lead: string, a: string, b: string, tail: string) => {
      const said = eventTimes(a, b, now);
      return said === null ? all : `${lead}${said}${tail}`;
    });
  return out.replace(NEW_START, (all: string, lead: string, a: string, tail: string) => {
    const d = parseIso(a);
    if (!d) return all;
    return `${lead}${a.includes("T") ? dateTime(d, now) : date(d, now)}${tail}`;
  });
}

/** "1 guest", "3 guests". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function due(
  iso: string | null,
  isDate: boolean,
  now = new Date(),
): { text: string; overdue: boolean; soon: boolean } | null {
  if (!iso) return null;
  const d = new Date(iso);
  const text = isDate ? day(d, now) : `${day(d, now)} ${time(d)}`;
  const ms = d.getTime() - now.getTime();
  return { text, overdue: ms < 0, soon: ms >= 0 && ms < DAY };
}

/** "just now", "5 min ago", "3 h ago", then a date. */
export function ago(iso: string, now = new Date()): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < DAY) return `${Math.floor(ms / 3_600_000)} h ago`;
  return day(new Date(iso), now);
}

export const STATUS_LABEL: Record<string, string> = {
  not_started: "To do",
  in_progress: "In progress",
  in_review: "In review",
  completed: "Done",
  canceled: "Canceled",
};

export const PRIORITY_LABEL: Record<string, string> = {
  none: "No priority",
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

export const TYPE_LABEL: Record<string, string> = {
  task: "Task",
  note: "Note",
  canvas: "Canvas",
  spreadsheet: "Spreadsheet",
  person: "Person",
  company: "Company",
  meeting: "Meeting",
  agent: "Agent",
  conversation: "Chat",
  comment: "Comment",
  brief: "Brief",
  journal: "Journal",
  page_watch: "Page watch",
  memory_note: "Memory",
  event: "Event",
  prep: "Prep",
  routine: "Routine",
  email_thread: "Email",
  email: "Email",
  slack_message: "Slack",
  github_pr: "Pull request",
};

export function who(principal: string): string {
  if (principal === "owner") return "You";
  if (principal === "jarvis") return "Jarvis";
  if (principal === "system") return "Hearth";
  return principal.replace(/^mcp:/, "");
}

/** Snooze choices: later today, this evening, tomorrow morning, next week. */
export function snoozeOptions(now = new Date()): { label: string; until: Date }[] {
  const at = (days: number, hour: number) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour);
    return d;
  };
  const opts = [
    { label: "In 3 hours", until: new Date(now.getTime() + 3 * 3_600_000) },
    { label: "This evening", until: at(0, 19) },
    { label: "Tomorrow morning", until: at(1, 9) },
    { label: "Next week", until: at(7 - ((now.getDay() + 6) % 7), 9) },
  ];
  return opts.filter((o) => o.until.getTime() > now.getTime() + 15 * 60_000);
}
