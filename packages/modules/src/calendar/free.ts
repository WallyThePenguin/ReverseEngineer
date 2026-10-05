// Free time: the gaps in your working hours that no busy event covers. Evenings and weekends are
// never free time for Hearth to fill.
import { addLocalDays, atLocal, type DayRules, localDate, localParts } from "@hearth/core";
import { calendar, calendarEvent, type DbOrTx } from "@hearth/db";
import { and, gt, lt, ne } from "drizzle-orm";
import { inSelectedCalendar } from "./calendars.ts";

export interface Slot {
  start: Date;
  end: Date;
}

/**
 * Busy time between two instants: events that block you and that you haven't declined, on
 * calendars you sync (a colleague's calendar you've turned off isn't your time).
 */
export async function busyTimes(db: DbOrTx, from: Date, to: Date): Promise<Slot[]> {
  const rows = await db
    .select({
      start: calendarEvent.startsAt,
      end: calendarEvent.endsAt,
      busy: calendarEvent.busy,
      allDay: calendarEvent.allDay,
      selfResponse: calendarEvent.selfResponse,
    })
    .from(calendarEvent)
    .innerJoin(calendar, inSelectedCalendar)
    .where(
      and(
        ne(calendarEvent.status, "cancelled"),
        lt(calendarEvent.startsAt, to),
        gt(calendarEvent.endsAt, from),
      ),
    );
  // All-day events (birthdays, "Home") don't block hours unless marked busy on purpose; Google
  // marks most of them free, so trust the busy flag either way.
  return rows
    .filter((r) => r.busy && r.selfResponse !== "declined")
    .map((r) => ({ start: r.start, end: r.end }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Working-hours windows between two instants, one per work day. */
export function workWindows(from: Date, to: Date, rules: DayRules): Slot[] {
  const out: Slot[] = [];
  for (let day = localDate(from, rules.timeZone); ; day = addLocalDays(day, 1)) {
    const start = atLocal(day, rules.workStart, rules.timeZone);
    if (start >= to) break;
    const weekday = localParts(start, rules.timeZone).weekday;
    if (!rules.workDays.includes(weekday)) continue;
    const end = atLocal(day, Math.min(rules.workEnd, rules.eveningStart), rules.timeZone);
    const s = start < from ? from : start;
    const e = end > to ? to : end;
    if (e > s) out.push({ start: s, end: e });
  }
  return out;
}

/** Takes busy times out of windows. Both lists sorted by start. */
export function subtract(windows: Slot[], busy: Slot[], bufferMinutes = 0): Slot[] {
  const pad = bufferMinutes * 60_000;
  const out: Slot[] = [];
  for (const w of windows) {
    let cursor = w.start.getTime();
    for (const b of busy) {
      const bs = b.start.getTime() - pad;
      const be = b.end.getTime() + pad;
      if (be <= cursor || bs >= w.end.getTime()) continue;
      if (bs > cursor) out.push({ start: new Date(cursor), end: new Date(bs) });
      cursor = Math.max(cursor, be);
    }
    if (cursor < w.end.getTime()) out.push({ start: new Date(cursor), end: w.end });
  }
  return out;
}

/** Free slots of at least `minutes`, starting no earlier than `from`. */
export async function freeSlots(
  db: DbOrTx,
  from: Date,
  to: Date,
  minutes: number,
  rules: DayRules,
  bufferMinutes = 0,
): Promise<Slot[]> {
  const windows = workWindows(from, to, rules);
  const busy = await busyTimes(db, from, to);
  return subtract(windows, busy, bufferMinutes).filter(
    (s) => s.end.getTime() - s.start.getTime() >= minutes * 60_000,
  );
}
