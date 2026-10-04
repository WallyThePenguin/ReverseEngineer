// A process's log as JSON lines (when, which process, how serious, what), next to what it
// prints. The service manager's own logs are plain text with no times; these can be searched
// and read back by time. The file rolls over at a size limit and a few old ones are kept, so it
// never fills the disk (the same scheme as Jarvis's turn log, D54).
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { format } from "node:util";

export type LogLevel = "info" | "warn" | "error";

export interface LogRecord {
  at: string;
  process: string;
  level: LogLevel;
  msg: string;
}

export interface FileLogOptions {
  /** Roll over past this size. */
  maxBytes?: number;
  /** Old files kept: server.jsonl.1 (newest) to server.jsonl.N. */
  keep?: number;
  /** Told once when the file can't be written; logging stops rather than failing every line. */
  onError?: (err: unknown) => void;
}

export type FileLog = (record: LogRecord) => void;

export function fileLog(file: string, opts: FileLogOptions = {}): FileLog {
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const keep = opts.keep ?? 5;
  let size: number | null = null;
  let broken = false;
  const roll = () => {
    rmSync(`${file}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) {
      if (statSync(`${file}.${i}`, { throwIfNoEntry: false }))
        renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    renameSync(file, `${file}.1`);
    size = 0;
  };
  return (record) => {
    if (broken) return;
    try {
      if (size === null) {
        mkdirSync(dirname(file), { recursive: true });
        size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
      }
      if (size >= maxBytes) roll();
      const line = `${JSON.stringify(record)}\n`;
      appendFileSync(file, line);
      size += Buffer.byteLength(line);
    } catch (err) {
      // A log that can't be written mustn't take the process down, or flood its console.
      broken = true;
      opts.onError?.(err);
    }
  };
}

const LEVELS: [keyof Console & ("log" | "info" | "warn" | "error"), LogLevel][] = [
  ["log", "info"],
  ["info", "info"],
  ["warn", "warn"],
  ["error", "error"],
];

/**
 * Copies everything this process prints with console.* into `write`, as records. What's printed
 * still goes to the console as before. Returns a function that puts the console back.
 */
export function teeConsole(name: string, write: FileLog, now = () => new Date()): () => void {
  const saved = LEVELS.map(([method]) => [method, console[method]] as const);
  for (const [method, level] of LEVELS) {
    const original = console[method];
    console[method] = (...args: unknown[]) => {
      original.apply(console, args);
      write({ at: now().toISOString(), process: name, level, msg: format(...args) });
    };
  }
  return () => {
    for (const [method, fn] of saved) console[method] = fn;
  };
}
