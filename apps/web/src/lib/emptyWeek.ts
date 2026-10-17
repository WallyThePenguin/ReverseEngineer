// What Calendar says about a week with nothing on. "Nothing on your calendar" only when Hearth
// would know: Google connected and syncing a calendar, and every day of the week one Hearth keeps.
// Otherwise it says what's missing, so a sign-out or a week past day 60 never reads as a free week.

import { date } from "./format.ts";
import type { CalendarSetup } from "./integration-types.ts";
import { SYNCED_DAYS_AHEAD, weeksOn } from "./week.ts";

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";

/** Past the last day Hearth keeps: where to look instead. */
export const pastKept = (until: Date) =>
  `Hearth keeps your calendar ${SYNCED_DAYS_AHEAD} days ahead, to ${date(new Date(until.getTime() - 1))}. For later, open Google Calendar.`;

/** The words for a week from `from` with nothing on, given what Hearth keeps (`until`). */
export function emptyWeek(from: Date, until: Date, setup: CalendarSetup): string {
  if (from >= until) return pastKept(until);
  const withCalendar = setup.accounts.filter((a) => a.scopes.includes(CALENDAR_SCOPE));
  const syncing = withCalendar.filter((a) => a.status !== "revoked");
  if (syncing.length === 0) {
    const out = withCalendar.find((a) => a.status === "revoked");
    if (out) return out.lastError || "Google signed Hearth out. Connect it again in Settings.";
    return "Google Calendar isn't connected yet. Connect it in Settings.";
  }
  const accounts = new Set(syncing.map((a) => a.email));
  if (!setup.calendars.some((c) => c.selected && accounts.has(c.account)))
    return "Hearth isn't syncing any of your calendars. Choose them in Settings.";
  if (syncing.every((a) => a.status === "failing"))
    return "Nothing here this week, but Hearth couldn't reach Google lately (Settings).";
  if (weeksOn(from, 1) > until)
    return `Nothing on your calendar to ${date(new Date(until.getTime() - 1))}. ${pastKept(until)}`;
  return "Nothing on your calendar this week.";
}
