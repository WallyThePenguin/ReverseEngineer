// Dates and times in what you type into a quick add: "dentist friday 3pm", "call mom tomorrow",
// "pay rent by oct 1", "stretch in 2 hours". The words that said when come out of the title, and
// the box shows the date as a chip you can take off before adding, so a misread ("Monday meeting
// notes") is never applied without you seeing it. English only, like the rest of Hearth's words.

const WEEKDAYS = [
  ["sunday"],
  ["mon", "monday"],
  ["tue", "tues", "tuesday"],
  ["wed", "weds", "wednesday"],
  ["thu", "thur", "thurs", "thursday"],
  ["fri", "friday"],
  // "sat" and "sun" alone are too often other words ("sat with Bob", "sun cream").
  ["saturday"],
] as const;
const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
] as const;
const COUNTS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5 };

const weekdayWord = WEEKDAYS.flat().join("|");
const monthWord =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const count = `(\\d{1,3}|${Object.keys(COUNTS).join("|")})`;
// Words that only lead into a date or time: they go with it.
const lead = "(?:(?:on|at|by|due|for|before)\\s+)?";
const atLead = "(?:(?:at|by|before|around)\\s+)?";

const DATE_PATTERNS: { re: RegExp; read: (m: RegExpExecArray, now: Date) => DateHit | null }[] = [
  {
    re: new RegExp(`\\b${lead}(today|tonight|tomorrow|tmrw|tmr)\\b`, "i"),
    read: (m, now) => ({ day: addDays(now, /^tom|^tmr/i.test(m[1]!) ? 1 : 0), weekday: false }),
  },
  {
    re: new RegExp(`\\b${lead}(?:(this|next)\\s+)?(${weekdayWord})\\b`, "i"),
    read: (m, now) => {
      const want = WEEKDAYS.findIndex((names) =>
        (names as readonly string[]).includes(m[2]!.toLowerCase()),
      );
      const ahead = (want - now.getDay() + 7) % 7;
      return { day: addDays(now, ahead + (m[1]?.toLowerCase() === "next" ? 7 : 0)), weekday: true };
    },
  },
  {
    re: new RegExp(`\\b${lead}in\\s+${count}\\s+(days?|weeks?)\\b`, "i"),
    read: (m, now) => {
      const n = amount(m[1]!);
      return { day: addDays(now, /^w/i.test(m[2]!) ? n * 7 : n), weekday: false };
    },
  },
  {
    re: new RegExp(`\\b${lead}next\\s+week\\b`, "i"),
    // The Monday after this week.
    read: (_m, now) => ({ day: addDays(now, (8 - now.getDay()) % 7 || 7), weekday: false }),
  },
  {
    re: new RegExp(`\\b${lead}(${monthWord})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i"),
    read: (m, now) => onDate(now, monthOf(m[1]!), Number(m[2])),
  },
  {
    re: new RegExp(`\\b${lead}(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthWord})\\b`, "i"),
    read: (m, now) => onDate(now, monthOf(m[2]!), Number(m[1])),
  },
];

const TIME_PATTERNS: { re: RegExp; read: (m: RegExpExecArray) => number | null }[] = [
  {
    re: new RegExp(
      `\\b${atLead}(\\d{1,2})(?::(\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)(?=\\s|$|[,;!?])`,
      "i",
    ),
    read: (m) => {
      const h = Number(m[1]);
      const min = Number(m[2] ?? 0);
      if (h < 1 || h > 12 || min > 59) return null;
      const pm = /^p/i.test(m[3]!);
      return ((h % 12) + (pm ? 12 : 0)) * 60 + min;
    },
  },
  {
    re: new RegExp(`\\b${atLead}([01]?\\d|2[0-3]):([0-5]\\d)\\b`, "i"),
    read: (m) => Number(m[1]) * 60 + Number(m[2]),
  },
  { re: new RegExp(`\\b${atLead}(noon|midday)\\b`, "i"), read: () => 12 * 60 },
  {
    // "at 3" is an afternoon; "at 9" a morning. Without "at", a bare number is just a number.
    re: /\bat\s+(\d{1,2})\b(?!:|\s*(?:%|am|pm|a\.m|p\.m))/i,
    read: (m) => {
      const h = Number(m[1]);
      if (h < 1 || h > 12) return null;
      return (h < 8 || h === 12 ? (h % 12) + 12 : h) * 60;
    },
  },
];

const IN_TIME = new RegExp(`\\b${lead}in\\s+${count}\\s+(hours?|hrs?|minutes?|mins?)\\b`, "i");

interface DateHit {
  day: Date;
  /** Said as a weekday: when that time has passed today, it means next week's. */
  weekday: boolean;
}

export interface When {
  /** What it's called, without the words that said when. */
  title: string;
  dueAt: string;
  /** A whole day, no time. */
  dueIsDate: boolean;
}

/**
 * What a quick add makes of what was typed: the title without its date and the due date, or just
 * the title when it names no time or you took the date off. Read again when it's added, so "in
 * 20 min" counts from then.
 */
export function taskFields(
  text: string,
  keepDate = true,
  now = new Date(),
): { title: string; dueAt?: string; dueIsDate?: boolean } {
  const w = keepDate ? readWhen(text, now) : null;
  return w ?? { title: text };
}

/** The due date in what was typed, and the title without it. Null when it names no time. */
export function readWhen(text: string, now = new Date()): When | null {
  let rest = text;
  const take = (m: RegExpExecArray) => {
    rest = `${rest.slice(0, m.index)} ${rest.slice(m.index + m[0].length)}`;
  };

  const rel = IN_TIME.exec(rest);
  if (rel) {
    const n = amount(rel[1]!);
    const minutes = /^h/i.test(rel[2]!) ? n * 60 : n;
    take(rel);
    const title = tidy(rest);
    if (!title) return null;
    return {
      title,
      dueAt: new Date(now.getTime() + minutes * 60_000).toISOString(),
      dueIsDate: false,
    };
  }

  let date: DateHit | null = null;
  for (const p of DATE_PATTERNS) {
    const m = p.re.exec(rest);
    const hit = m && p.read(m, now);
    if (m && hit) {
      date = hit;
      take(m);
      break;
    }
  }
  let minutes: number | null = null;
  for (const p of TIME_PATTERNS) {
    const m = p.re.exec(rest);
    const hit = m && p.read(m);
    if (m && hit !== null) {
      minutes = hit;
      take(m);
      break;
    }
  }
  if (!date && minutes === null) return null;
  const title = tidy(rest);
  if (!title) return null;

  if (minutes === null) return { title, dueAt: date!.day.toISOString(), dueIsDate: true };
  let at = atMinutes(date?.day ?? now, minutes);
  // A time that's already gone today: tomorrow's, or next week's for today's weekday. "Today 3pm"
  // typed at 4pm stays today: you said so.
  if (at.getTime() <= now.getTime() && (!date || (date.weekday && sameDay(date.day, now))))
    at = addDays(at, date ? 7 : 1, minutes);
  return { title, dueAt: at.toISOString(), dueIsDate: false };
}

// How long an event lasts: "1h", "90 min", "for 2 hours". Not "in 2 hours", which says when.
const LASTS = /(?<!\bin\s)\b(?:for\s+)?(\d{1,2}(?:\.\d+)?)\s*(h|hrs?|hours?|m|mins?|minutes?)\b/i;

export interface EventDraft {
  title: string;
  /** ISO date-time, or YYYY-MM-DD for an all-day event. */
  start: string;
  /** ISO date-time, or the day after an all-day event's day. */
  end: string;
  allDay: boolean;
}

/**
 * An event from a line like "Dentist Fri 3pm 1h": an hour unless it says how long, all day when
 * it names a day but no time. Null when it doesn't say when.
 */
export function readEvent(text: string, now = new Date()): EventDraft | null {
  let rest = text;
  let minutes = 60;
  const long = LASTS.exec(text);
  if (long) {
    const n = Number(long[1]);
    minutes = Math.round(/^h/i.test(long[2]!) ? n * 60 : n);
    rest = `${text.slice(0, long.index)} ${text.slice(long.index + long[0].length)}`;
  }
  const w = readWhen(rest, now);
  if (!w || minutes <= 0) return null;
  const start = new Date(w.dueAt);
  if (w.dueIsDate)
    return { title: w.title, start: day(start), end: day(addDays(start, 1)), allDay: true };
  const end = new Date(start.getTime() + minutes * 60_000).toISOString();
  return { title: w.title, start: w.dueAt, end, allDay: false };
}

/** "2026-10-09": the day on this computer's calendar. */
const day = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Local midnight `n` days after `d`'s day, at `minutes` past it. */
function addDays(d: Date, n: number, minutes = 0): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 0, minutes);
}

const atMinutes = (day: Date, minutes: number) => addDays(day, 0, minutes);

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

const amount = (word: string) => COUNTS[word.toLowerCase()] ?? Number(word);

const monthOf = (word: string) =>
  MONTHS.indexOf(word.slice(0, 3).toLowerCase() as (typeof MONTHS)[number]);

/** That day this year, or next year once it's gone. Null for a day the month doesn't have. */
function onDate(now: Date, month: number, day: number): DateHit | null {
  if (month < 0 || day < 1 || day > 31) return null;
  let d = new Date(now.getFullYear(), month, day);
  if (d.getMonth() !== month) return null;
  if (d.getTime() < addDays(now, 0).getTime()) d = new Date(now.getFullYear() + 1, month, day);
  return { day: d, weekday: false };
}

/** The title once the date's words are out: single spaces, no dangling comma or dash. */
function tidy(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, "")
    .trim();
}
