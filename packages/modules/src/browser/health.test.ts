import { describe, expect, it } from "vitest";
import type { BrowserStatus } from "./client.ts";
import { browserHealth } from "./health.ts";

const base: BrowserStatus = { connected: false, version: null, since: null, tabs: [] };

describe("Chrome's health", () => {
  it.each([
    [{ paired: false }, "ok", "No Chrome extension is paired"],
    [{ connected: true, version: "0.3.0" }, "ok", "Connected (extension 0.3.0)"],
    [{ connected: true, problem: "out of date" }, "degraded", "out of date"],
    [{ openError: "Chrome isn't installed." }, "failing", "Chrome isn't installed."],
    [{ opening: true }, "ok", "Opening Chrome"],
    [{ canOpen: true }, "ok", "Hearth opens it when Jarvis needs it"],
    [{}, "degraded", "Chrome isn't connected"],
  ] as const)("%o is %s", (s, status, detail) => {
    const h = browserHealth({ ...base, ...s });
    expect(h.status).toBe(status);
    expect(h.detail).toContain(detail);
  });
});
