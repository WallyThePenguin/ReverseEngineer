// Calendar's week, by day: the days with something on, and each one's events. The week starts on
// a day, not a minute, and Calendar keys each day's section by its date, so neither the minute
// moving on nor the week read again unchanged draws a day or an event again. What's chosen in one
// stays chosen: a recurring invite's "This time only", an open choice, the focus.

import { type Accessor, createMemo } from "solid-js";
import { createToday } from "./clock.ts";
import type { CalEvent } from "./types.ts";

const DAY_MS = 86_400_000;

/** Where the week shown starts: the start of today, `offset` weeks on. */
export function createWeekStart(offset: Accessor<number>): Accessor<Date> {
  const today = createToday();
  return createMemo(() => new Date(today() + offset() * 7 * DAY_MS));
}

/**
 * The week's events by day, in their order: its days (each a `toDateString()`, which a `<For>`
 * keeps a section by) and each day's events. One that began before the week is on its first day.
 */
export function byDay(events: Accessor<readonly CalEvent[] | undefined>, from: Accessor<Date>) {
  const groups = createMemo(() => {
    const days = new Map<string, CalEvent[]>();
    for (const e of events() ?? []) {
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
