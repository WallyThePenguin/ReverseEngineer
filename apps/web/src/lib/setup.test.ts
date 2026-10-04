import { describe, expect, it } from "vitest";
import { setupSteps } from "./setup.ts";
import type { SystemStatus } from "./types.ts";

const NOW = Date.parse("2026-10-04T12:00:00Z");
const base: SystemStatus = {
  setup: { google: false, chrome: false, phone: false, desktop: false },
  jarvisPaused: false,
  jarvisAlive: null,
  components: {},
  schedules: [],
};
const done = (s: SystemStatus) =>
  Object.fromEntries(setupSteps(s, NOW).map((step) => [step.id, step.done]));

describe("setupSteps", () => {
  it("is empty when the server doesn't report setup", () => {
    const { setup: _gone, ...old } = base;
    expect(setupSteps(old, NOW)).toEqual([]);
    expect(setupSteps(undefined, NOW)).toEqual([]);
  });

  it("starts with everything to do, Jarvis first", () => {
    const steps = setupSteps(base, NOW);
    expect(steps.map((s) => s.id)).toEqual([
      "jarvis",
      "google",
      "chrome",
      "phone",
      "desktop",
      "backup",
    ]);
    expect(steps.every((s) => !s.done)).toBe(true);
    expect(steps[0]!.detail).toMatch(/hasn't started/);
    expect(steps.at(-1)!.detail).toBe("No backup has run yet.");
  });

  it("ticks what's connected, a running Jarvis and a good backup", () => {
    const s: SystemStatus = {
      ...base,
      setup: { google: true, chrome: true, phone: false, desktop: true },
      jarvisAlive: { at: "2026-10-04T11:59:40Z", since: "2026-10-04T08:00:00Z", pid: 1 },
      components: { backup: { status: "ok", detail: "", at: "2026-10-04T03:00:00Z" } },
    };
    expect(done(s)).toEqual({
      jarvis: true,
      google: true,
      chrome: true,
      phone: false,
      desktop: true,
      backup: true,
    });
  });

  it("says when Jarvis stopped or a backup needs a look", () => {
    const s: SystemStatus = {
      ...base,
      jarvisAlive: { at: "2026-10-04T11:50:00Z", since: "2026-10-04T08:00:00Z", pid: 1 },
      components: {
        backup: { status: "failing", detail: "disk full", at: "2026-10-04T03:00:00Z" },
      },
    };
    const steps = setupSteps(s, NOW);
    expect(steps[0]).toMatchObject({ done: false, detail: expect.stringMatching(/stopped/) });
    expect(steps.at(-1)).toMatchObject({ done: false, detail: "Backups need a look: disk full" });
  });
});
