// An inbox row's body is cut to three lines, except a Slack message Jarvis wrote that didn't go
// out: the card has nothing to open, so all of what was stopped shows on it.
import { QueryClient } from "@tanstack/solid-query";
import { describe, expect, it, vi } from "vitest";

vi.mock("./live.ts", () => ({
  queryClient: new QueryClient(),
  live: { refresh: () => {}, connected: () => false },
  toast: { show: () => {} },
  reportError: () => {},
}));

const { wholeBody } = await import("./inbox.ts");

describe("an inbox row's body", () => {
  it("shows whole on a Slack message that didn't go out, and cut short elsewhere", () => {
    expect(wholeBody({ kind: "slack.not_sent" })).toBe(true);
    expect(wholeBody({ kind: "system.alert" })).toBe(false);
    expect(wholeBody({ kind: "mail.needs_reply" })).toBe(false);
  });
});
