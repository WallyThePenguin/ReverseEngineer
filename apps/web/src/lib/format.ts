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
