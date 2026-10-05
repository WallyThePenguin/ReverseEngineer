import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileLog, type LogRecord, teeConsole } from "./file-log.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hearth-log-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const rec = (msg: string): LogRecord => ({
  at: "2026-10-04T12:00:00.000Z",
  process: "server",
  level: "info",
  msg,
});
const lines = (file: string) =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as LogRecord);

describe("fileLog", () => {
  it("writes one JSON record per line, making its folder", () => {
    const file = join(dir, "logs", "server.jsonl");
    const log = fileLog(file);
    log(rec("one"));
    log({ ...rec('two "quoted"\nand a second line'), level: "error" });
    expect(lines(file)).toEqual([
      rec("one"),
      { ...rec('two "quoted"\nand a second line'), level: "error" },
    ]);
  });

  it("rolls over at the size limit and keeps only the newest few", () => {
    const file = join(dir, "worker.jsonl");
    const log = fileLog(file, { maxBytes: 200, keep: 2 });
    for (let i = 0; i < 20; i++) log(rec(`line ${i} ${"x".repeat(40)}`));
    expect(readdirSync(dir).sort()).toEqual(["worker.jsonl", "worker.jsonl.1", "worker.jsonl.2"]);
    const newest = lines(file);
    expect(newest.at(-1)?.msg).toMatch(/^line 19 /);
    // Older lines moved down a file, oldest dropped.
    expect(lines(`${file}.1`).at(-1)?.msg).toBe(`line ${20 - newest.length - 1} ${"x".repeat(40)}`);
  });

  it("counts what's already in the file, so a restart rolls it at the right size", () => {
    const file = join(dir, "server.jsonl");
    writeFileSync(file, "x".repeat(300));
    fileLog(file, { maxBytes: 200 })(rec("after a restart"));
    expect(readFileSync(`${file}.1`, "utf8")).toBe("x".repeat(300));
    expect(lines(file)).toEqual([rec("after a restart")]);
  });

  it("keeps writing when it can't roll over (the file held open elsewhere), and tries again later", () => {
    const file = join(dir, "server.jsonl");
    // In the way of the roll-over: a folder where the oldest file goes, like a file another
    // program holds open on Windows.
    mkdirSync(`${file}.1`);
    writeFileSync(join(`${file}.1`, "held"), "");
    const errors: unknown[] = [];
    const log = fileLog(file, { maxBytes: 200, keep: 1, onError: (e) => errors.push(e) });
    for (let i = 0; i < 12; i++) log(rec(`line ${i} ${"x".repeat(40)}`));
    expect(errors).toHaveLength(1);
    expect(lines(file).map((l) => l.msg.split(" ")[1])).toEqual(
      Array.from({ length: 12 }, (_, i) => String(i)),
    );
    // Once it's free, the next roll-over goes through.
    rmSync(`${file}.1`, { recursive: true });
    for (let i = 12; i < 20; i++) log(rec(`line ${i} ${"x".repeat(40)}`));
    expect(readdirSync(dir).sort()).toEqual(["server.jsonl", "server.jsonl.1"]);
    expect(lines(file).at(-1)?.msg).toMatch(/^line 19 /);
  });

  it("says once when it can't write, then stays quiet", () => {
    const blocker = join(dir, "not-a-folder");
    writeFileSync(blocker, "");
    const errors: unknown[] = [];
    const log = fileLog(join(blocker, "server.jsonl"), { onError: (e) => errors.push(e) });
    log(rec("one"));
    log(rec("two"));
    expect(errors).toHaveLength(1);
  });
});

describe("teeConsole", () => {
  it("copies console output into records, and still prints it", () => {
    const got: LogRecord[] = [];
    const printed = vi.spyOn(console, "warn").mockImplementation(() => {});
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const restore = teeConsole(
      "worker",
      (r) => got.push(r),
      () => new Date(0),
    );
    console.warn("[push] couldn't send to %s: %d", "iPhone", 410);
    console.error(new Error("boom"));
    restore();
    console.warn("after restore");
    expect(got).toHaveLength(2);
    expect(got[0]).toEqual({
      at: "1970-01-01T00:00:00.000Z",
      process: "worker",
      level: "warn",
      msg: "[push] couldn't send to iPhone: 410",
    });
    expect(got[1]).toMatchObject({ level: "error", msg: expect.stringContaining("Error: boom") });
    expect(printed).toHaveBeenCalledTimes(2);
    printed.mockRestore();
    quiet.mockRestore();
  });
});
