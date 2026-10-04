import { afterEach, describe, expect, it } from "vitest";
import { processGuards } from "./process.ts";

afterEach(() => {
  process.exitCode = undefined;
});

describe("process guards", () => {
  it("log a promise nobody caught and keep the process running", () => {
    const lines: string[] = [];
    const exits: number[] = [];
    const g = processGuards("server", { log: (l) => lines.push(l), exit: (c) => exits.push(c) });
    g.rejection(new Error("Failed query: select $1\nparams: hunter2"));
    expect(lines[0]).toMatch(/^\[server\] a background task failed and nothing caught it: /);
    expect(lines[0]).not.toContain("hunter2");
    expect(exits).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it("log an uncaught exception and end the process so it starts afresh", () => {
    const lines: string[] = [];
    const exits: number[] = [];
    const g = processGuards("worker", { log: (l) => lines.push(l), exit: (c) => exits.push(c) });
    g.exception(new TypeError("x is undefined"));
    expect(lines[0]).toContain("[worker] stopped by an unexpected error (uncaughtException)");
    expect(lines[0]).toContain("TypeError");
    expect(exits).toEqual([1]);
  });
});
