// Your time rules: every clock time is 12-hour Eastern, dates stay ISO, work is 9 a.m. to
// 6 p.m. on weekdays, the evening is yours, and quiet hours run 10 p.m. to 8 a.m.
import { TZDate } from "@date-fns/tz";

export interface DayRules {
  timeZone: string;
  /** Minutes after local midnight. */
  workStart: number;
  workEnd: number;
  /** From here to midnight is yours: never scheduled over. */
  eveningStart: number;
  quietStart: number;
  quietEnd: number;
  /** 0 = Sunday. */
  workDays: number[];
}

export const DEFAULT_DAY_RULES: DayRules = {
  timeZone: "America/New_York",
  workStart: 9 * 60,
  workEnd: 18 * 60,
  eveningStart: 19 * 60,
  quietStart: 22 * 60,
  quietEnd: 8 * 60,
  workDays: [1, 2, 3, 4, 5],
};

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

/** An IANA zone this runtime knows ("America/New_York"); a typo ("America/New York") isn't. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function localParts(date: Date, timeZone: string): LocalParts {
  const d = new TZDate(date.getTime(), timeZone);
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
    weekday: d.getDay(),
  };
}

export function minuteOfDay(date: Date, timeZone: string): number {
  const p = localParts(date, timeZone);
  return p.hour * 60 + p.minute;
}

/** Local calendar date as YYYY-MM-DD. */
export function localDate(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** The instant of local midnight starting the day that contains `date`. */
export function startOfLocalDay(date: Date, timeZone: string): Date {
  const d = new TZDate(date.getTime(), timeZone);
  d.setHours(0, 0, 0, 0);
  return new Date(d.getTime());
}

/** The instant a local date ("2026-10-02") reaches `minute` minutes after midnight. */
export function atLocal(date: string, minute: number, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new TZDate(y, m - 1, d, Math.floor(minute / 60), minute % 60, 0, 0, timeZone);
  return new Date(t.getTime());
}

/** A local date `days` days after another ("2026-10-31" + 1 = "2026-11-01"). */
export function addLocalDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** The next instant, at or after `date`, whose local time is `minute` minutes after midnight. */
export function nextLocalTime(date: Date, minute: number, timeZone: string): Date {
  const d = new TZDate(date.getTime(), timeZone);
  d.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
  if (d.getTime() < date.getTime()) d.setDate(d.getDate() + 1);
  return new Date(d.getTime());
}

function inWindow(m: number, start: number, end: number): boolean {
  return start <= end ? m >= start && m < end : m >= start || m < end;
}

export function isQuietHours(date: Date, rules: DayRules = DEFAULT_DAY_RULES): boolean {
  return inWindow(minuteOfDay(date, rules.timeZone), rules.quietStart, rules.quietEnd);
}

export function isWorkHours(date: Date, rules: DayRules = DEFAULT_DAY_RULES): boolean {
  const p = localParts(date, rules.timeZone);
  if (!rules.workDays.includes(p.weekday)) return false;
  return inWindow(p.hour * 60 + p.minute, rules.workStart, rules.workEnd);
}

export function isEvening(date: Date, rules: DayRules = DEFAULT_DAY_RULES): boolean {
  return minuteOfDay(date, rules.timeZone) >= rules.eveningStart;
}

/** "10 a.m.", "3:30 p.m." */
export function formatTime(date: Date, timeZone: string = DEFAULT_DAY_RULES.timeZone): string {
  const { hour, minute } = localParts(date, timeZone);
  const h = hour % 12 === 0 ? 12 : hour % 12;
  const suffix = hour < 12 ? "a.m." : "p.m.";
  return minute === 0 ? `${h} ${suffix}` : `${h}:${String(minute).padStart(2, "0")} ${suffix}`;
}

/** "2026-10-01 3:30 p.m." */
export function formatDateTime(date: Date, timeZone: string = DEFAULT_DAY_RULES.timeZone): string {
  return `${localDate(date, timeZone)} ${formatTime(date, timeZone)}`;
}
