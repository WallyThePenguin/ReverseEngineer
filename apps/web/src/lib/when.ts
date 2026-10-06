// Dates and times in what you type into a quick add: "dentist friday 3pm", "call mom tomorrow",
// "pay rent by oct 1", "stretch in 2 hours", "standup Fri Oct 16 3-4pm". The words that said when
// come out of the title, and the box shows the date as a chip you can take off before adding, so
// a misread ("Monday meeting notes") is never applied without you seeing it. English only, like
// the rest of Hearth's words.

const WEEKDAYS = [
  ["sun", "sunday"],
  ["mon", "monday"],
  ["tue", "tues", "tuesday"],
  ["wed", "weds", "wednesday"],
  ["thu", "thur", "thurs", "thursday"],
  ["fri", "friday"],
  ["sat", "saturday"],
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

const anyWeekday = WEEKDAYS.flat().join("|");
const weekdayWord = WEEKDAYS.flat()
  .filter((w) => w !== "sat" && w !== "sun")
  .join("|");
// "Sat" and "Sun" alone are too often other words ("sat with Bob", "the sun deck"): they're days
// when on, by, this or next leads in, or a time or a length follows ("Brunch Sun 11am").
const soon =
  "(?:at\\s+)?\\d{1,2}(?::\\d{2})?\\s*[ap]\\.?m\\b|(?:at\\s+)?\\d{1,2}:\\d{2}|at\\s+\\d|noon|midday|morning|afternoon|evening|night|\\d{1,2}(?:\\.\\d+)?\\s*(?:h|hrs?|hours?|m|mins?|minutes?)\\b";
const weekend = `(?<=\\b(?:on|by|due|before|this|next)\\s+)(?:sat|sun)|(?:sat|sun)(?=\\.?,?\\s+(?:${soon}))`;
const monthWord =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const count = `(\\d{1,3}|${Object.keys(COUNTS).join("|")})`;
// Words that only lead into a date or time: they go with it.
const lead = "(?:(?:on|at|by|due|for|before)\\s+)?";
const atLead = "(?:(?:at|by|before|around)\\s+)?";
// "Monday's meeting" and "today's list" name no date.
const own = "(?!['’]s\\b)";
// The weekday that may come with a date: "Fri Oct 16", "Friday, the 16th of October".
const withWeekday = `(?:(${anyWeekday})\\.?,?\\s+(?:the\\s+)?)?`;
const meridiem = "(a\\.?m\\.?|p\\.?m\\.?)";

const DATE_PATTERNS: { re: RegExp; read: (m: RegExpExecArray, now: Date) => DateHit | null }[] = [
  {
    re: new RegExp(`\\b${lead}(today|tonight|tomorrow|tmrw|tmr)\\b${own}`, "i"),
    read: (m, now) => ({
      day: addDays(now, /^tom|^tmr/i.test(m[1]!) ? 1 : 0),
      weekday: false,
      evening: /^tonight$/i.test(m[1]!),
    }),
  },
  // A date said outright wins over a weekday, which goes with it.
  {
    re: new RegExp(
      `\\b${lead}${withWeekday}(${monthWord})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`,
      "i",
    ),
    read: (m, now) => onDate(now, monthOf(m[2]!), Number(m[3]), m[1]),
  },
  {
    re: new RegExp(
      `\\b${lead}${withWeekday}(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthWord})\\b`,
      "i",
    ),
    read: (m, now) => onDate(now, monthOf(m[3]!), Number(m[2]), m[1]),
  },
  {
    // "next week tuesday", "tuesday of next week": that day in the week after this one.
    re: new RegExp(
      `\\b${lead}(?:next\\s+week\\s+(?:on\\s+)?(${anyWeekday})|(${anyWeekday})\\s+(?:of\\s+)?next\\s+week)\\b`,
      "i",
    ),
    read: (m, now) => ({
      day: addDays(nextMonday(now), (dayOf(m[1] ?? m[2]!) + 6) % 7),
      weekday: false,
    }),
  },
  {
    re: new RegExp(`\\b${lead}(?:(this|next)\\s+)?(${weekdayWord}|${weekend})\\b${own}`, "i"),
    read: (m, now) => {
      const ahead = (dayOf(m[2]!) - now.getDay() + 7) % 7;
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
    read: (_m, now) => ({ day: nextMonday(now), weekday: false }),
  },
];

const TIME_PATTERNS: {
  re: RegExp;
  read: (m: RegExpExecArray, evening: boolean) => number | null;
}[] = [
  {
    re: new RegExp(`\\b${atLead}(\\d{1,2})(?::(\\d{2}))?\\s*${meridiem}(?=\\s|$|[,;!?])`, "i"),
    read: (m) => clock(m[1]!, m[2], m[3]),
  },
  {
    re: new RegExp(`\\b${atLead}(\\d{1,2}):([0-5]\\d)\\b`, "i"),
    read: (m, evening) => clock(m[1]!, m[2], undefined, evening),
  },
  { re: new RegExp(`\\b${atLead}(noon|midday)\\b`, "i"), read: () => 12 * 60 },
  {
    // "at 3" when nothing follows it but the end, or o'clock: "look at 3 options" is no time.
    // Without "at", a bare number is just a number.
    re: /\bat\s+(\d{1,2})(?:\s*o['’]?clock\b|(?=\s*(?:$|[,.;!?)])))/i,
    read: (m, evening) => clock(m[1]!, undefined, undefined, evening),
  },
];

// "3-4pm", "10am to 11am", "15:00-16:00": a start and an end. One end has to say am or pm, or
// both have minutes, so "chapters 3-4" is no time.
const RANGE = new RegExp(
  `\\b${atLead}(?:from\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*${meridiem}?\\s*(?:-|–|—|to|until|till)\\s*(\\d{1,2})(?::(\\d{2}))?\\s*${meridiem}?(?=\\s|$|[,;!?])`,
  "i",
);

const IN_TIME = new RegExp(`\\b${lead}in\\s+${count}\\s+(hours?|hrs?|minutes?|mins?)\\b`, "i");

interface DateHit {
  day: Date;
  /** Said as a weekday: when that time has passed today, it means next week's. */
  weekday: boolean;
  /** "tonight": a time without am or pm is in the evening. */
  evening?: boolean;
  /** Words to leave in the title: a weekday that doesn't match the date said with it. */
  keep?: string;
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
  const w = read(text, now);
  return w && { title: w.title, dueAt: w.dueAt, dueIsDate: w.dueIsDate };
}

/** As readWhen, with how long a range ("3-4pm") lasts, in minutes. */
function read(text: string, now: Date): (When & { lasts?: number }) | null {
  let rest = text;
  const take = (m: RegExpExecArray, keep = "") => {
    rest = `${rest.slice(0, m.index)} ${keep} ${rest.slice(m.index + m[0].length)}`;
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
      take(m, hit.keep);
      break;
    }
  }
  const evening = date?.evening === true;
  let minutes: number | null = null;
  let lasts: number | undefined;
  const r = RANGE.exec(rest);
  const span = r && range(r, evening);
  if (r && span) {
    ({ start: minutes, lasts } = span);
    take(r);
  } else
    for (const p of TIME_PATTERNS) {
      const m = p.re.exec(rest);
      const hit = m && p.read(m, evening);
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
  return { title, dueAt: at.toISOString(), dueIsDate: false, ...(lasts ? { lasts } : {}) };
}

/**
 * Minutes into the day for a time on a clock face. Without am or pm, 1 to 7 (and 12) are the
 * afternoon and 8 to 11 the morning, as people mean "at 3" and "at 9", and in the evening
 * ("tonight at 8") all of them are. A leading zero or 13 to 23 is a 24-hour time.
 */
function clock(hour: string, min: string | undefined, half: string | undefined, evening = false) {
  const h = Number(hour);
  const m = Number(min ?? 0);
  if (m > 59) return null;
  if (half) return h < 1 || h > 12 ? null : ((h % 12) + (/^p/i.test(half) ? 12 : 0)) * 60 + m;
  if (h > 23) return null;
  if (hour.startsWith("0") || h >= 13) return h * 60 + m;
  return (evening || h < 8 || h === 12 ? (h % 12) + 12 : h) * 60 + m;
}

/** A range's start and how long it lasts, in minutes. */
function range(r: RegExpExecArray, evening: boolean): { start: number; lasts: number } | null {
  const [, h1, m1, half1, h2, m2, half2] = r;
  if (!half1 && !half2 && !(m1 && m2)) return null;
  // "3-4pm": the start is in the end's half of the day, unless that puts it after the end.
  let start = clock(h1!, m1, half1 ?? half2, evening);
  let end = clock(h2!, m2, half2, evening);
  if (start === null || end === null) return null;
  if (!half1 && half2 && start >= end && start >= 12 * 60) start -= 12 * 60;
  // "7:30-8:30" ends in the evening it started in.
  if (!half2 && end <= start && end < 12 * 60 && end + 12 * 60 > start) end += 12 * 60;
  // Past midnight: "10pm-1am".
  const lasts = (end - start + 24 * 60) % (24 * 60);
  return lasts ? { start, lasts } : null;
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
 * An event from a line like "Dentist Fri 3pm 1h" or "Standup 10-10:15am": an hour unless it says
 * how long, all day when it names a day but no time. Null when it doesn't say when.
 */
export function readEvent(text: string, now = new Date()): EventDraft | null {
  let rest = text;
  let minutes: number | undefined;
  const long = LASTS.exec(text);
  if (long) {
    const n = Number(long[1]);
    minutes = Math.round(/^h/i.test(long[2]!) ? n * 60 : n);
    // "Hike Sat 3h": the length that said Sat is a day goes, so say the day in full.
    const before = text
      .slice(0, long.index)
      .replace(
        /\b(sat|sun)\.?\s*$/i,
        (_, d: string) => `${d}${/^sat/i.test(d) ? "urday" : "day"} `,
      );
    rest = `${before} ${text.slice(long.index + long[0].length)}`;
  }
  const w = read(rest, now);
  minutes ??= w?.lasts ?? 60;
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

/** The Monday after this week. */
const nextMonday = (now: Date) => addDays(now, (8 - now.getDay()) % 7 || 7);

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

const amount = (word: string) => COUNTS[word.toLowerCase()] ?? Number(word);

const dayOf = (word: string) =>
  WEEKDAYS.findIndex((names) => (names as readonly string[]).includes(word.toLowerCase()));

const monthOf = (word: string) =>
  MONTHS.indexOf(word.slice(0, 3).toLowerCase() as (typeof MONTHS)[number]);

/**
 * That day this year, or next year's once it's more than a month gone ("jan 15" in October); a
 * date just gone ("oct 1" on the 6th) is overdue, not a year off. A weekday said with it goes with
 * it when it matches, and stays in the title when it doesn't, so you see the mismatch. Null for a
 * day the month doesn't have.
 */
function onDate(now: Date, month: number, date: number, weekday?: string): DateHit | null {
  if (month < 0 || date < 1 || date > 31) return null;
  let d = new Date(now.getFullYear(), month, date);
  if (d.getTime() < addDays(now, -30).getTime()) d = new Date(now.getFullYear() + 1, month, date);
  if (d.getMonth() !== month) return null;
  const keep = weekday && dayOf(weekday) !== d.getDay() ? weekday : undefined;
  return { day: d, weekday: false, ...(keep ? { keep } : {}) };
}

/** The title once the date's words are out: single spaces, no dangling comma or dash. */
function tidy(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, "")
    .trim();
}
