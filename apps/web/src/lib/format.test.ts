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

  it("turns a meeting's range into words", () => {
    expect(
      humanTimes(`Invite a@x.example, b@x.example to "Offsite prep" ${start} to ${end}`, NOW),
    ).toBe('Invite a@x.example, b@x.example to "Offsite prep" Wed, Oct 7, 4 to 4:30 p.m.');
  });

  it("turns a single time and an all-day range into words", () => {
    expect(humanTimes(`Update a meeting to start ${start}, telling its guests`, NOW)).toBe(
      "Update a meeting to start Wed, Oct 7, 4 p.m., telling its guests",
    );
    expect(humanTimes('Add "Away" 2026-10-07 to 2026-10-09 to your calendar', NOW)).toBe(
      'Add "Away" Wed, Oct 7 to Fri, Oct 9 to your calendar',
    );
    expect(humanTimes(`Add "Call" ${start} to 2026-10-08 to your calendar`, NOW)).toBe(
      'Add "Call" Wed, Oct 7, 4 p.m. to Thu, Oct 8 to your calendar',
    );
  });

  it("leaves quoted titles, file names and anything else alone", () => {
    const quoted = `Add "Standup ${start}" ${start} to ${end} to your calendar`;
    expect(humanTimes(quoted, NOW)).toBe(
      `Add "Standup ${start}" Wed, Oct 7, 4 to 4:30 p.m. to your calendar`,
    );
    expect(humanTimes("Attach report-2026-10-07.pdf and v2026-10-07", NOW)).toBe(
      "Attach report-2026-10-07.pdf and v2026-10-07",
    );
    expect(humanTimes("Send email to dana@example.com", NOW)).toBe(
      "Send email to dana@example.com",
    );
    expect(humanTimes("Remind me on 2026-13-45", NOW)).toBe("Remind me on 2026-13-45");
  });
});
