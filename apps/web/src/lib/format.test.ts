import { describe, expect, it } from "vitest";
import { date, dateTime, hours, humanTimes, plural, span } from "./format.ts";

const NOW = new Date(2026, 9, 5, 9, 0);

/** A local time as JSON writes it with its offset, whatever zone the tests run in. */
function iso(d: Date): string {
  const off = -d.getTimezoneOffset();
  const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
  const sign = off < 0 ? "-" : "+";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${pad(off / 60)}:${pad(off % 60)}`;
}

describe("dates and times as you'd say them", () => {
  it("names the day, with the year only when it isn't this one", () => {
    expect(date(new Date(2026, 9, 7), NOW)).toBe("Wed, Oct 7");
    expect(date(new Date(2027, 0, 4), NOW)).toBe("Mon, Jan 4, 2027");
    expect(dateTime(new Date(2026, 9, 7, 16, 30), NOW)).toBe("Wed, Oct 7, 4:30 p.m.");
  });

  it("says a time to a time once when both are in the same half of the day", () => {
    expect(hours(new Date(2026, 9, 7, 16), new Date(2026, 9, 7, 16, 30))).toBe("4 to 4:30 p.m.");
    expect(hours(new Date(2026, 9, 7, 11, 30), new Date(2026, 9, 7, 13))).toBe(
      "11:30 a.m. to 1 p.m.",
    );
  });

  it("gives a span across days both its days", () => {
    expect(span(new Date(2026, 9, 7, 16), new Date(2026, 9, 7, 16, 30), NOW)).toBe(
      "Wed, Oct 7, 4 to 4:30 p.m.",
    );
    expect(span(new Date(2026, 9, 7, 22), new Date(2026, 9, 8, 1), NOW)).toBe(
      "Wed, Oct 7, 10 p.m. to Thu, Oct 8, 1 a.m.",
    );
  });

  it("counts one and many", () => {
    expect(plural(1, "guest")).toBe("1 guest");
    expect(plural(3, "guest")).toBe("3 guests");
    expect(plural(0, "person", "people")).toBe("0 people");
  });
});

describe("humanTimes", () => {
  const start = iso(new Date(2026, 9, 7, 16));
  const end = iso(new Date(2026, 9, 7, 16, 30));

  it("puts a meeting's times in words", () => {
    expect(
      humanTimes(`Invite a@x.example, b@x.example to "Offsite prep" ${start} to ${end}`, NOW),
    ).toBe('Invite a@x.example, b@x.example to "Offsite prep" Wed, Oct 7, 4 to 4:30 p.m.');
    expect(humanTimes(`Jarvis asks: Add "Call" ${start} to ${end} to your calendar`, NOW)).toBe(
      'Jarvis asks: Add "Call" Wed, Oct 7, 4 to 4:30 p.m. to your calendar',
    );
    expect(humanTimes(`Update a meeting to start ${start}, telling its guests`, NOW)).toBe(
      "Update a meeting to start Wed, Oct 7, 4 p.m., telling its guests",
    );
    expect(
      humanTimes(
        `Update a meeting to start ${start} as "Plan 2026-10-09", telling its guests`,
        NOW,
      ),
    ).toBe('Update a meeting to start Wed, Oct 7, 4 p.m. as "Plan 2026-10-09", telling its guests');
  });

  it("says an all-day event's last day, not the day after it", () => {
    // Google's end for an all-day event is the day after its last (calendar/actions.ts).
    expect(humanTimes('Add "Dentist" 2026-10-07 to 2026-10-08 to your calendar', NOW)).toBe(
      'Add "Dentist" Wed, Oct 7, all day to your calendar',
    );
    expect(humanTimes('Add "Away" 2026-10-07 to 2026-10-10 to your calendar', NOW)).toBe(
      'Add "Away" Wed, Oct 7 to Fri, Oct 9 to your calendar',
    );
    // A day with a time, or an end before its start, isn't an event Hearth makes: as written.
    for (const odd of [
      `Add "Call" ${start} to 2026-10-08 to your calendar`,
      'Add "Back to front" 2026-10-08 to 2026-10-07 to your calendar',
      'Add "Not a day" 2026-02-30 to 2026-03-01 to your calendar',
    ])
      expect(humanTimes(odd, NOW)).toBe(odd);
  });

  it("only reads the event's own times, never ones in its title", () => {
    const tricky = `Add "Lunch" 2026-10-09 to 2026-10-10 "${start}" ${start} to ${end} to your calendar`;
    expect(humanTimes(tricky, NOW)).toBe(
      `Add "Lunch" 2026-10-09 to 2026-10-10 "${start}" Wed, Oct 7, 4 to 4:30 p.m. to your calendar`,
    );
  });

  it("leaves links, paths, file names, quotes and any other sentence exactly as written", () => {
    for (const asis of [
      "Open https://example.com/events/2026-10-07 in Chrome",
      "Go to https://example.com/book?date=2026-10-07&t=2026-10-07T16:00",
      "Watch https://example.com/#2026-10-07 to 2026-10-08",
      "Attach report 2026-10-07.pdf",
      "Attach report-2026-10-07.pdf and v2026-10-07",
      "Save to C:/Reports/2026-10-07/notes.txt",
      "Rename 'Plan 2026-10-07' and “2026-10-07”",
      'Create a task "Trip" 2026-10-07 to 2026-10-08',
      `Remind me ${start}`,
      "Send email to dana@example.com",
    ])
      expect(humanTimes(asis, NOW)).toBe(asis);
  });
});
