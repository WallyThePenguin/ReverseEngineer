// Quick adds understand dates: the date comes out of the title and becomes the due date, a time
// that's gone means the next one, and text that names no time is left alone.
import { describe, expect, it } from "vitest";
import { readEvent, readWhen } from "./when.ts";

// Tuesday 6 October 2026, 10:00 on this computer's clock.
const NOW = new Date(2026, 9, 6, 10, 0);
const at = (month: number, day: number, h = 0, m = 0) =>
  new Date(2026, month - 1, day, h, m).toISOString();
const read = (text: string, now = NOW) => readWhen(text, now);

describe("readWhen", () => {
  it("reads a day and a time, and takes them out of the title", () => {
    expect(read("dentist friday 3pm")).toEqual({
      title: "dentist",
      dueAt: at(10, 9, 15),
      dueIsDate: false,
    });
    expect(read("call dentist tomorrow 10am")).toEqual({
      title: "call dentist",
      dueAt: at(10, 7, 10),
      dueIsDate: false,
    });
  });

  it("makes a day without a time a whole-day due date", () => {
    expect(read("call mom tomorrow")).toEqual({
      title: "call mom",
      dueAt: at(10, 7),
      dueIsDate: true,
    });
    expect(read("Pay rent by Oct 15th")).toMatchObject({ title: "Pay rent", dueAt: at(10, 15) });
    expect(read("renew passport on 3 November")).toMatchObject({
      title: "renew passport",
      dueAt: at(11, 3),
    });
    expect(read("report due in 2 weeks")).toMatchObject({ title: "report", dueAt: at(10, 20) });
    expect(read("plan trip next week")).toMatchObject({ title: "plan trip", dueAt: at(10, 12) });
  });

  it("takes the little words that lead into a date with it", () => {
    expect(read("dentist on Friday at 3:30 pm")).toMatchObject({
      title: "dentist",
      dueAt: at(10, 9, 15, 30),
    });
    expect(read("Send invoice, by noon")).toMatchObject({
      title: "Send invoice",
      dueAt: at(10, 6, 12),
    });
  });

  it("reads 24-hour times, and 'at 3' as the afternoon", () => {
    expect(read("standup 09:15")).toMatchObject({ dueAt: at(10, 7, 9, 15) });
    expect(read("call Sam at 3")).toMatchObject({ title: "call Sam", dueAt: at(10, 6, 15) });
    expect(read("gym at 9")).toMatchObject({ dueAt: at(10, 7, 9) });
    expect(read("call at 3 o'clock with Sam")).toMatchObject({
      title: "call with Sam",
      dueAt: at(10, 6, 15),
    });
  });

  it("reads '3:30' the way it reads 'at 3', unless it's a 24-hour time", () => {
    expect(read("call Sam 3:30")).toMatchObject({ dueAt: at(10, 6, 15, 30) });
    expect(read("call Sam at 3:30")).toMatchObject({ title: "call Sam", dueAt: at(10, 6, 15, 30) });
    expect(read("standup 10:30")).toMatchObject({ dueAt: at(10, 6, 10, 30) });
    expect(read("lunch 12:15")).toMatchObject({ dueAt: at(10, 6, 12, 15) });
    expect(read("standup 03:30")).toMatchObject({ dueAt: at(10, 7, 3, 30) });
    expect(read("review 15:45")).toMatchObject({ dueAt: at(10, 6, 15, 45) });
  });

  it("reads 'tonight' times as the evening", () => {
    expect(read("call Ana tonight at 8")).toMatchObject({
      title: "call Ana",
      dueAt: at(10, 6, 20),
    });
    expect(read("film tonight 9:30")).toMatchObject({ dueAt: at(10, 6, 21, 30) });
    expect(read("pack tonight")).toMatchObject({ dueAt: at(10, 6), dueIsDate: true });
  });

  it("reads Sat and Sun as days when a time follows or a word leads in", () => {
    expect(read("Brunch Sun 11am")).toMatchObject({ title: "Brunch", dueAt: at(10, 11, 11) });
    expect(read("lunch on sat")).toMatchObject({ title: "lunch", dueAt: at(10, 10) });
    expect(read("clean garage this sun")).toMatchObject({ dueAt: at(10, 11) });
    expect(read("buy sun cream 3pm")).toMatchObject({ title: "buy sun cream" });
  });

  it("puts a date said outright before a weekday, and keeps a weekday that doesn't match it", () => {
    expect(read("Dentist Fri Oct 16 3pm")).toEqual({
      title: "Dentist",
      dueAt: at(10, 16, 15),
      dueIsDate: false,
    });
    expect(read("Dentist on Friday, 16th of October")).toMatchObject({
      title: "Dentist",
      dueAt: at(10, 16),
    });
    expect(read("Dentist Thu Oct 16")).toMatchObject({ title: "Dentist Thu", dueAt: at(10, 16) });
  });

  it("reads a weekday of next week", () => {
    expect(read("plan trip next week tuesday")).toMatchObject({
      title: "plan trip",
      dueAt: at(10, 13),
    });
    expect(read("plan trip tuesday next week 9am")).toMatchObject({ dueAt: at(10, 13, 9) });
    expect(read("call Ana next week on friday")).toMatchObject({ dueAt: at(10, 16) });
    expect(read("call Ana sunday of next week")).toMatchObject({ dueAt: at(10, 18) });
  });

  it("reads a range by its start", () => {
    expect(read("standup 3-4pm")).toMatchObject({ title: "standup", dueAt: at(10, 6, 15) });
    expect(read("read chapters 3-4")).toBeNull();
  });

  it("moves a time that's gone today to tomorrow, and today's weekday to next week", () => {
    expect(read("call mom 9am")).toMatchObject({ dueAt: at(10, 7, 9) });
    expect(read("call mom 11am")).toMatchObject({ dueAt: at(10, 6, 11) });
    expect(read("team sync tuesday 9am")).toMatchObject({ dueAt: at(10, 13, 9) });
    expect(read("team sync tuesday 2pm")).toMatchObject({ dueAt: at(10, 6, 14) });
  });

  it("keeps today when you said today, even once its time has gone", () => {
    expect(read("submit form today 9am")).toMatchObject({ dueAt: at(10, 6, 9) });
  });

  it("reads 'next' weekdays as the week after, and dates gone this year as next year's", () => {
    expect(read("lunch next friday")).toMatchObject({ dueAt: at(10, 16) });
    expect(read("lunch this friday")).toMatchObject({ dueAt: at(10, 9) });
    expect(read("taxes jan 15")?.dueAt).toBe(new Date(2027, 0, 15).toISOString());
    // Just gone is overdue, not next year.
    expect(read("pay rent oct 1")).toMatchObject({ dueAt: at(10, 1), dueIsDate: true });
    expect(read("pay rent sep 1")?.dueAt).toBe(new Date(2027, 8, 1).toISOString());
  });

  it("reads 'in' an amount of time from now", () => {
    expect(read("stretch in 2 hours")).toEqual({
      title: "stretch",
      dueAt: new Date(NOW.getTime() + 2 * 3_600_000).toISOString(),
      dueIsDate: false,
    });
    expect(read("check oven in 20 min")?.dueAt).toBe(
      new Date(NOW.getTime() + 20 * 60_000).toISOString(),
    );
    expect(read("follow up in a week")).toMatchObject({ dueAt: at(10, 13) });
  });

  it("leaves alone text that names no time, or is nothing but one", () => {
    expect(read("buy milk")).toBeNull();
    expect(read("tomorrow")).toBeNull();
    expect(read("read chapter 3")).toBeNull();
    expect(read("sat with Bob about the sun deck")).toBeNull();
    expect(read("may want to rethink this")).toBeNull();
    expect(read("move 3 amazing chairs")).toBeNull();
    expect(read("feb 30 party")).toBeNull();
    expect(read("Monday's meeting notes")).toBeNull();
    expect(read("tidy up today's list")).toBeNull();
    expect(read("Look at 3 options")).toBeNull();
  });
});

describe("readEvent", () => {
  it("makes an hour-long event unless it says how long", () => {
    expect(readEvent("Dentist Fri 3pm", NOW)).toEqual({
      title: "Dentist",
      start: at(10, 9, 15),
      end: at(10, 9, 16),
      allDay: false,
    });
    expect(readEvent("Dentist Fri 3pm 1h", NOW)?.end).toBe(at(10, 9, 16));
    expect(readEvent("Focus tomorrow 9am for 2 hours", NOW)).toMatchObject({
      title: "Focus",
      end: at(10, 7, 11),
    });
    expect(readEvent("call with Ana 4:30pm 45 min", NOW)).toMatchObject({
      title: "call with Ana",
      start: at(10, 6, 16, 30),
      end: at(10, 6, 17, 15),
    });
  });

  it("takes a range's end as the event's", () => {
    expect(readEvent("Standup 3-4pm", NOW)).toMatchObject({
      title: "Standup",
      start: at(10, 6, 15),
      end: at(10, 6, 16),
    });
    expect(readEvent("Review Fri 10am-11:30am", NOW)).toMatchObject({
      start: at(10, 9, 10),
      end: at(10, 9, 11, 30),
    });
    expect(readEvent("Lunch tomorrow 11-1pm", NOW)).toMatchObject({
      start: at(10, 7, 11),
      end: at(10, 7, 13),
    });
    expect(readEvent("Talk 3pm to 4:15pm", NOW)?.end).toBe(at(10, 6, 16, 15));
    expect(readEvent("Party Sat 10pm-1am", NOW)).toMatchObject({
      start: at(10, 10, 22),
      end: at(10, 11, 1),
    });
    expect(readEvent("Walk tonight 7:30-8:30", NOW)?.end).toBe(at(10, 6, 20, 30));
  });

  it("reads Sat or Sun before a length as the day", () => {
    expect(readEvent("Hike Sat 3h", NOW)).toMatchObject({ title: "Hike", start: "2026-10-10" });
    expect(readEvent("Brunch Sun 11am 2h", NOW)).toMatchObject({
      start: at(10, 11, 11),
      end: at(10, 11, 13),
    });
  });

  it("makes an all-day event of a day with no time", () => {
    expect(readEvent("Mom's birthday oct 20", NOW)).toEqual({
      title: "Mom's birthday",
      start: "2026-10-20",
      end: "2026-10-21",
      allDay: true,
    });
  });

  it("starts 'in 2 hours' from now rather than lasting two hours", () => {
    expect(readEvent("Stretch in 2 hours", NOW)).toMatchObject({
      start: new Date(NOW.getTime() + 2 * 3_600_000).toISOString(),
      end: new Date(NOW.getTime() + 3 * 3_600_000).toISOString(),
    });
  });

  it("needs a when", () => {
    expect(readEvent("Dentist 1h", NOW)).toBeNull();
    expect(readEvent("Dentist", NOW)).toBeNull();
  });
});
