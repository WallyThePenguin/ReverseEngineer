// A week with nothing on is called free only when Hearth would know: not when Google signed Hearth
// out, no calendar is synced, or part of the week is past the days Hearth keeps.
import { describe, expect, it } from "vitest";
import { emptyWeek } from "./emptyWeek.ts";
import type { CalendarSetup } from "./integration-types.ts";

const CAL = "https://www.googleapis.com/auth/calendar";
const until = new Date(2026, 11, 6);
const oct = new Date(2026, 9, 7);

const setup = (
  status: "ok" | "failing" | "revoked" = "ok",
  more: { scopes?: string[]; selected?: boolean; lastError?: string } = {},
): CalendarSetup =>
  ({
    configured: true,
    accounts: [
      {
        email: "me@x.example",
        status,
        lastError: more.lastError ?? null,
        connectedAt: "2026-09-01T00:00:00Z",
        scopes: more.scopes ?? [CAL],
      },
    ],
    calendars: [{ account: "me@x.example", selected: more.selected ?? true }],
  }) as CalendarSetup;

describe("a week with nothing on", () => {
  it("is free only when Hearth syncs your calendar and keeps the whole week", () => {
    expect(emptyWeek(oct, until, setup())).toBe("Nothing on your calendar this week.");
    // Dec 2 to 8: Hearth has only up to Dec 5.
    const edge = emptyWeek(new Date(2026, 11, 2), until, setup());
    expect(edge).toMatch(/^Nothing on your calendar to .*Dec.* 5\. Hearth keeps/);
    expect(edge).toContain("Google Calendar");
    expect(emptyWeek(new Date(2026, 11, 9), until, setup())).toMatch(/^Hearth keeps/);
  });

  it("says what's missing instead", () => {
    expect(emptyWeek(oct, until, setup("revoked"))).toBe(
      "Google signed Hearth out. Connect it again in Settings.",
    );
    expect(emptyWeek(oct, until, setup("revoked", { lastError: "Sign in again." }))).toBe(
      "Sign in again.",
    );
    expect(emptyWeek(oct, until, { ...setup(), accounts: [] })).toBe(
      "Google Calendar isn't connected yet. Connect it in Settings.",
    );
    expect(emptyWeek(oct, until, setup("ok", { scopes: ["openid"] }))).toMatch(/isn't connected/);
    expect(emptyWeek(oct, until, setup("ok", { selected: false }))).toBe(
      "Hearth isn't syncing any of your calendars. Choose them in Settings.",
    );
    expect(emptyWeek(oct, until, setup("failing"))).toMatch(/couldn't reach Google lately/);
  });
});
