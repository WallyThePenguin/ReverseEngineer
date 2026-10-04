import { describe, expect, it } from "vitest";
import { jarvisLiveness, outcomeLabel } from "./jarvis-health.ts";
import type { SystemStatus } from "./types.ts";

const now = Date.parse("2026-10-01T14:00:00Z");
const status = (
  aliveAgoMs: number | null,
  jarvis?: "ok" | "degraded" | "failing",
): SystemStatus => ({
  jarvisPaused: false,
  jarvisAlive:
    aliveAgoMs === null
      ? null
      : { at: new Date(now - aliveAgoMs).toISOString(), since: "2026-10-01T09:00:00Z", pid: 1 },
  components: jarvis
    ? { jarvis: { status: jarvis, detail: `Jarvis is ${jarvis}`, at: "2026-10-01T13:59:00Z" } }
    : {},
  schedules: [],
});

describe("jarvisLiveness", () => {
  it("is well while Jarvis checks in and its turns finish", () => {
    expect(jarvisLiveness(status(30_000, "ok"), now)).toEqual({
      downSince: null,
      detail: null,
      unwell: false,
    });
  });

  it("says since when Jarvis hasn't been running", () => {
    const l = jarvisLiveness(status(5 * 60_000, "ok"), now);
    expect(l.downSince).toEqual(new Date(now - 5 * 60_000));
    expect(l.unwell).toBe(true);
  });

  it("shows failing turns as unwell, and retries as a note only", () => {
    expect(jarvisLiveness(status(10_000, "failing"), now)).toMatchObject({
      unwell: true,
      detail: "Jarvis is failing",
    });
    expect(jarvisLiveness(status(10_000, "degraded"), now)).toMatchObject({
      unwell: false,
      detail: "Jarvis is degraded",
    });
  });

  it("assumes nothing before Jarvis has ever checked in", () => {
    expect(jarvisLiveness(status(null), now).unwell).toBe(false);
    expect(jarvisLiveness(undefined, now).unwell).toBe(false);
  });
});

describe("outcomeLabel", () => {
  it("says how a routine's last turn went", () => {
    expect(outcomeLabel("done")).toBe("finished");
    expect(outcomeLabel("skipped_paused")).toBe("skipped");
    expect(outcomeLabel(null)).toBeNull();
    expect(outcomeLabel("something new")).toBeNull();
  });
});
