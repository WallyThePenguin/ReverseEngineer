// Calendar's week, by day: the days with something on, and each one's events. The week starts on
// a day, not a minute, and Calendar keys each day's section by its date, so neither the minute
// moving on nor the week read again unchanged draws a day or an event again. What's chosen in one
// stays chosen: a recurring invite's "This time only", an open choice, the focus.

import { type Accessor, createMemo } from "solid-js";
import { createToday } from "./clock.ts";
import { isPlan } from "./today.ts";
import type { CalEvent } from "./types.ts";

/** How far ahead Hearth keeps your calendar (calendar/sync.ts SYNC_AHEAD_DAYS). */
export const SYNCED_DAYS_AHEAD = 60;

/** The first day Hearth doesn't have: the start of the day `SYNCED_DAYS_AHEAD` days on. */
export const syncedUntil = (today: Date) =>
  new Date(today.getFullYear(), today.getMonth(), today.getDate() + SYNCED_DAYS_AHEAD);

/** The start of the day `weeks` weeks on from `day`: by the calendar, so a week the clocks
 *  change in still starts at midnight, not an hour either side of it. */
export const weeksOn = (day: Date, weeks: number) =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate() + 7 * weeks);

/** Where the week shown starts: the start of today, `offset` weeks on. */
export function createWeekStart(offset: Accessor<number>): Accessor<Date> {
  const today = createToday();
  return createMemo(() => weeksOn(new Date(today()), offset()));
}

/**
 * The week's events by day, in their order: its days (each a `toDateString()`, which a `<For>`
 * keeps a section by) and each day's events. One that began before the week is on its first day.
 */
export function byDay(events: Accessor<readonly CalEvent[] | undefined>, from: Accessor<Date>) {
  const groups = createMemo(() => {
    const days = new Map<string, CalEvent[]>();
    for (const e of events() ?? []) {
      if (!isPlan(e)) continue;
      const start = new Date(e.startsAt);
      const key = (start < from() ? from() : start).toDateString();
      const list = days.get(key);
      if (list) list.push(e);
      else days.set(key, [e]);
    }
    return days;
  });
  return {
    days: () => [...groups().keys()],
    on: (day: string) => groups().get(day) ?? [],
  };
}
