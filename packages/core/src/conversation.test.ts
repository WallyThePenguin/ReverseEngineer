import { describe, expect, it } from "vitest";
import { foldConversation, type LogRecord } from "./conversation.ts";

let idx = 0;
const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 14, 0, s)).toISOString();
const entry = (kind: string, payload: Record<string, unknown>, turnId: string | null = null) =>
  ({ idx: idx++, at: at(idx), turnId, kind, payload }) satisfies LogRecord;

describe("foldConversation", () => {
  it("knows when you're waiting for Jarvis to start", () => {
    idx = 0;
    const asked = [entry("user_message", { text: "hi" })];
    expect(foldConversation(asked).waitingSince).toBe(at(1));
    const started = [...asked, entry("turn_started", {}, "t1")];
    expect(foldConversation(started)).toMatchObject({ waitingSince: null, activeTurns: ["t1"] });

    // Said while that turn runs: still waiting after it ends, until the next one starts.
    const more = [...started, entry("user_message", { text: "also" })];
    const ended = [
      ...more,
      entry("assistant_message", { text: "Hi." }, "t1"),
      entry("turn_finished", { status: "done" }, "t1"),
    ];
    expect(foldConversation(ended).waitingSince).toBe(at(3));
    // Stopped before it started: no longer waiting.
    const stopped = [...ended, entry("notice", { text: "Stopped before Jarvis started." }, "t2")];
    expect(foldConversation(stopped).waitingSince).toBeNull();
  });

  it("doesn't wait on a routine's own prompt", () => {
    idx = 0;
    const log = [
      entry("turn_started", {}, "r1"),
      entry("user_message", { text: "It's time for the brief.", by: "system" }, "r1"),
      entry("turn_finished", { status: "done" }, "r1"),
    ];
    expect(foldConversation(log).waitingSince).toBeNull();
  });

  it("offers Retry on the latest failure only, until something else happens", () => {
    idx = 0;
    const log = [
      entry("user_message", { text: "one" }),
      entry("turn_started", {}, "t1"),
      entry("error", { message: "Claude turned down the request.", retry: true }, "t1"),
      entry("turn_finished", { status: "failed" }, "t1"),
    ];
    const notice = (l: LogRecord[]) => foldConversation(l).items.filter((i) => i.type === "notice");
    expect(notice(log)).toMatchObject([{ tone: "error", retry: true, turnId: "t1" }]);
    expect(foldConversation(log).activeTurns).toEqual([]);

    const retried = [...log, entry("turn_started", {}, "t2")];
    expect(notice(retried)).toMatchObject([{ retry: false }]);

    const waiting = [
      entry(
        "error",
        { message: "Claude is overloaded. Jarvis will try again.", retry: false },
        "t3",
      ),
    ];
    expect(notice(waiting)).toMatchObject([{ retry: false }]);
  });
});
