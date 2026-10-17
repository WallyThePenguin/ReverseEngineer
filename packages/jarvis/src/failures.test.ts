import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrainError, classifyFailure, type FailureKind, friendlyError } from "./failures.ts";
import { fileTurnLog, type TurnLogLine } from "./turn-log.ts";

describe("classifyFailure", () => {
  const cases: [string, FailureKind][] = [
    [
      'API Error: 400 {"error":{"message":"tools.124.custom.input_schema: JSON schema is invalid"}}',
      "bad_tool",
    ],
    [
      'API Error: 400 {"error":{"type":"invalid_request_error","message":"bad"}}',
      "invalid_request",
    ],
    ["API Error: 401 OAuth token has expired", "auth"],
    ["Claude AI usage limit reached|1790000000", "rate_limit"],
    ["API Error: 429 rate_limit_error", "rate_limit"],
    ['API Error: 529 {"type":"overloaded_error"}', "overloaded"],
    ["API Error: 500 Internal server error", "overloaded"],
    ["Claude Code process exited with code 1", "crashed"],
    ["fetch failed: ECONNRESET", "network"],
    ["Request timed out", "network"],
    ["No conversation found with session ID: abc", "session_gone"],
    ["something odd", "unknown"],
  ];
  it.each(cases)("reads %s", (text, kind) => {
    expect(classifyFailure(new Error(text)).kind).toBe(kind);
  });

  it("reads the tool's place and the reset time", () => {
    expect(classifyFailure(new Error("400 tools.7.custom.input_schema: x")).toolIndex).toBe(7);
    expect(classifyFailure(new Error("usage limit reached|1790000000")).resetsAt).toEqual(
      new Date(1790000000 * 1000),
    );
  });

  it("trusts the SDK's label over the text, and a brain's own verdict over both", () => {
    expect(classifyFailure(new Error("Something"), "billing_error").kind).toBe("auth");
    const err = new BrainError("bad_tool", "x", { toolIndex: 3, tool: "sheet_save" });
    expect(classifyFailure(err, "overloaded")).toMatchObject({
      kind: "bad_tool",
      tool: "sheet_save",
    });
  });
});

describe("friendlyError", () => {
  const c = { timeZone: "America/New_York", now: new Date("2026-10-01T14:00:00Z") };
  it("says when Jarvis will try again, and offers Retry only when it won't", () => {
    const later = friendlyError("overloaded", { ...c, retryAt: new Date("2026-10-01T14:05:00Z") });
    expect(later).toEqual({
      text: "Claude is overloaded right now. Pip will try again at 10:05 a.m.",
      retry: false,
    });
    expect(friendlyError("overloaded", c).retry).toBe(true);
    const tomorrow = friendlyError("rate_limit", {
      ...c,
      retryAt: new Date("2026-10-02T13:00:00Z"),
    });
    expect(tomorrow.text).toBe(
      "You've hit your Claude usage limit. Pip will try again tomorrow at 9 a.m.",
    );
  });

  it("never passes on the error text", () => {
    const kinds: FailureKind[] = ["bad_tool", "invalid_request", "auth", "unknown", "timeout"];
    for (const k of kinds) expect(friendlyError(k, c).text).not.toMatch(/API|400|error/i);
  });
});

describe("the turn log", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const line = (i: number): TurnLogLine => ({
    at: new Date(i * 1000).toISOString(),
    turnId: `t${i}`,
    trigger: "chat",
    lane: "fast",
    mode: "reactive",
    status: "done",
    attempt: 1,
    errorKind: null,
    durationMs: 1200,
    firstTokenMs: 300,
    tools: 0,
  });

  it("writes a JSON line per turn and rolls over, keeping a few old files", () => {
    dir = mkdtempSync(join(tmpdir(), "hearth-turns-"));
    const file = join(dir, "logs", "turns.jsonl");
    const log = fileTurnLog(file, { maxBytes: 400, keep: 2 });
    for (let i = 0; i < 20; i++) log(line(i));
    expect(readdirSync(join(dir, "logs")).sort()).toEqual([
      "turns.jsonl",
      "turns.jsonl.1",
      "turns.jsonl.2",
    ]);
    const last = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(last.at(-1)).toMatchObject({ turnId: "t19", status: "done", firstTokenMs: 300 });
  });

  it("never throws when it can't write", () => {
    dir = mkdtempSync(join(tmpdir(), "hearth-turns-"));
    const errors: unknown[] = [];
    // A folder where the file should be.
    const log = fileTurnLog(dir, { onError: (e) => errors.push(e) });
    expect(() => log(line(1))).not.toThrow();
    expect(errors).toHaveLength(1);
  });
});
