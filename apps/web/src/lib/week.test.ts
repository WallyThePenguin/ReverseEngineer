// Calendar's week keeps each day's section, and each event's row, as the minute moves on and when
// the week is read again unchanged: a recurring invite's "This time only" stays chosen until you
// answer, rather than going back to "Every time" and declining the whole series.
import { createRoot, createSignal, mapArray } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalEvent } from "./types.ts";
import { byDay, createWeekStart, syncedUntil, weeksOn } from "./week.ts";

// Solid's browser build: the server build tests run with by default isn't reactive.
// @ts-expect-error: the browser build has no types of its own; they're the package's.
vi.mock("solid-js", () => import("solid-js/dist/solid.js"));

const event = (id: string, at: Date) => ({ id, startsAt: at.toISOString() }) as CalEvent;

describe("the week, by day", () => {
  it("leaves out where you work and birthdays, and knows how far ahead Hearth keeps", () => {
    createRoot((dispose) => {
      const day = new Date(2026, 9, 7);
      const week = byDay(
        () => [
          { ...event("office", day), kind: "workingLocation" },
          { ...event("sam", day), kind: "birthday" },
          { ...event("lunch", day), kind: "default" },
        ],
        () => day,
      );
      expect(week.on(day.toDateString()).map((e) => e.id)).toEqual(["lunch"]);
      dispose();
    });
    expect(syncedUntil(new Date(2026, 9, 7, 15))).toEqual(new Date(2026, 11, 6));
  });

  afterEach(() => vi.useRealTimers());

  // One run: the clock starts ticking once, with the first thing that reads it.
  it("keeps a day, its rows and what's chosen in them until the day turns", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 7, 9, 0, 30));
    createRoot((dispose) => {
      const [events, setEvents] = createSignal([
        event("late", new Date(2026, 9, 6, 22)),
        event("lunch", new Date(2026, 9, 7, 12)),
        event("review", new Date(2026, 9, 8, 14)),
      ]);
      const [offset, setOffset] = createSignal(0);
      const from = createWeekStart(offset);
      const week = byDay(events, from);
      expect(from()).toEqual(new Date(2026, 9, 7));
      // Begun the day before the week: on its first day.
      expect(week.on(new Date(2026, 9, 7).toDateString()).map((e) => e.id)).toEqual([
        "late",
        "lunch",
      ]);
      // As Calendar's <For>s draw them: a section a day, a row an event, each made once.
      const sections = mapArray(week.days, (day) => {
        // The invite's answer, as InviteAnswers keeps it: "Every time" until you pick.
        const [scope, setScope] = createSignal("all");
        const rows = mapArray(
          () => week.on(day),
          (e) => ({ e }),
        );
        return { day, scope, setScope, rows };
      });
      const today = sections()[0]!;
      const row = today.rows()[1]!;
      today.setScope("one");
      vi.advanceTimersByTime(60_000);
      expect(sections()[0]).toBe(today);
      expect(today.rows()[1]).toBe(row);
      expect(today.scope()).toBe("one");
      // Read again, nothing changed (keepUnchanged keeps the same events): still the same.
      setEvents([...events()]);
      expect(sections()[0]).toBe(today);
      expect(today.rows()[1]).toBe(row);
      expect(today.scope()).toBe("one");
      // Past midnight, the week starts a day on; a week on, a week on from that.
      vi.advanceTimersByTime(15 * 3_600_000);
      expect(from()).toEqual(new Date(2026, 9, 8));
      setOffset(1);
      expect(from()).toEqual(new Date(2026, 9, 15));
      dispose();
    });
  });

  it("starts a week the clocks change in at midnight", () => {
    // New York's clocks go back an hour on 1 November 2026: that week is 7 days and an hour long.
    vi.stubEnv("TZ", "America/New_York");
    try {
      expect(weeksOn(new Date(2026, 9, 29), 1)).toEqual(new Date(2026, 10, 5));
      expect(weeksOn(new Date(2026, 10, 5), -1)).toEqual(new Date(2026, 9, 29));
      expect(weeksOn(new Date(2026, 9, 29, 15), 0)).toEqual(new Date(2026, 9, 29));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
