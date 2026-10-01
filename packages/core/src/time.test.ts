import { describe, expect, it } from "vitest";
import { decideInterrupt } from "./interrupts.ts";
import { isStaleFiring, nextCronRun } from "./schedule.ts";
import { findTaskNumbers, parseTaskNumber, taskBranchName } from "./tasks.ts";
import {
  formatDateTime,
  formatTime,
  isEvening,
  isQuietHours,
  isWorkHours,
  localDate,
  nextLocalTime,
  startOfLocalDay,
} from "./time.ts";

// 2026-10-01 is a Thursday; New York is on EDT (UTC-4).
const at = (iso: string) => new Date(iso);

describe("time rules", () => {
  it("formats 12-hour Eastern times", () => {
    expect(formatTime(at("2026-10-01T14:00:00Z"))).toBe("10 a.m.");
    expect(formatTime(at("2026-10-01T19:30:00Z"))).toBe("3:30 p.m.");
    expect(formatTime(at("2026-10-01T16:00:00Z"))).toBe("12 p.m.");
    expect(formatTime(at("2026-10-01T04:05:00Z"))).toBe("12:05 a.m.");
    expect(formatDateTime(at("2026-10-02T01:00:00Z"))).toBe("2026-10-01 9 p.m.");
  });

  it("knows work hours, the evening and quiet hours", () => {
    expect(isWorkHours(at("2026-10-01T14:00:00Z"))).toBe(true); // Thu 10 a.m.
    expect(isWorkHours(at("2026-10-03T14:00:00Z"))).toBe(false); // Sat
    expect(isWorkHours(at("2026-10-01T22:30:00Z"))).toBe(false); // 6:30 p.m.
    expect(isEvening(at("2026-10-01T23:30:00Z"))).toBe(true); // 7:30 p.m.
    expect(isQuietHours(at("2026-10-02T03:00:00Z"))).toBe(true); // 11 p.m.
    expect(isQuietHours(at("2026-10-01T11:00:00Z"))).toBe(true); // 7 a.m.
    expect(isQuietHours(at("2026-10-01T12:00:00Z"))).toBe(false); // 8 a.m.
  });

  it("finds local midnight and the next local time across DST", () => {
    expect(startOfLocalDay(at("2026-10-01T14:00:00Z"), "America/New_York").toISOString()).toBe(
      "2026-10-01T04:00:00.000Z",
    );
    expect(localDate(at("2026-10-02T03:00:00Z"), "America/New_York")).toBe("2026-10-01");
    // Nov 1 2026 is the end of DST: 8 a.m. that day is 13:00Z.
    expect(
      nextLocalTime(at("2026-11-01T05:00:00Z"), 8 * 60, "America/New_York").toISOString(),
    ).toBe("2026-11-01T13:00:00.000Z");
  });
});

describe("interrupt budget", () => {
  const noon = at("2026-10-01T16:00:00Z");
  it("delivers within budget and holds once spent", () => {
    expect(decideInterrupt({ now: noon, deliveredToday: 3 })).toEqual({
      deliver: true,
      reason: "within_budget",
    });
    expect(decideInterrupt({ now: noon, deliveredToday: 8 })).toMatchObject({
      deliver: false,
      reason: "budget_spent",
    });
  });
  it("lets a deadline within 24 hours break through the cap", () => {
    const deadline = at("2026-10-02T13:00:00Z");
    expect(decideInterrupt({ now: noon, deliveredToday: 8, deadline })).toEqual({
      deliver: true,
      reason: "deadline_breakthrough",
    });
  });
  it("holds until morning in quiet hours unless the deadline can't wait", () => {
    const night = at("2026-10-02T03:00:00Z"); // 11 p.m.
    const held = decideInterrupt({
      now: night,
      deliveredToday: 0,
      deadline: at("2026-10-02T20:00:00Z"),
    });
    expect(held).toEqual({
      deliver: false,
      reason: "quiet_hours",
      retryAt: at("2026-10-02T12:00:00Z"),
    });
    const wake = decideInterrupt({
      now: night,
      deliveredToday: 0,
      deadline: at("2026-10-02T06:00:00Z"),
    });
    expect(wake).toEqual({ deliver: true, reason: "deadline_breakthrough" });
  });
});

describe("schedules and tasks", () => {
  it("computes the next cron run in the owner's time zone", () => {
    const next = nextCronRun("15 8 * * *", "America/New_York", at("2026-10-01T13:00:00Z"));
    expect(next.toISOString()).toBe("2026-10-02T12:15:00.000Z");
  });
  it("skips stale firings", () => {
    expect(isStaleFiring(at("2026-10-01T10:00:00Z"), at("2026-10-01T10:30:00Z"), 3600)).toBe(false);
    expect(isStaleFiring(at("2026-10-01T10:00:00Z"), at("2026-10-01T12:00:00Z"), 3600)).toBe(true);
    expect(isStaleFiring(at("2026-10-01T10:00:00Z"), at("2026-10-09T12:00:00Z"), null)).toBe(false);
  });
  it("handles task numbers and branch names", () => {
    expect(parseTaskNumber("t-42")).toBe(42);
    expect(findTaskNumbers("Fix login (T-12), see T-7 and T-12")).toEqual([12, 7]);
    expect(taskBranchName("jarvis", 123, "Fix the Login Page!")).toBe(
      "jarvis/T-123-fix-the-login-page",
    );
  });
});
