// Last-resort handlers for Hearth's long-running processes (the server, the worker, the CLI).
// Node ends the process on a promise nobody caught, so one forgotten .catch() in a background
// task (a WebSocket check, a fire-and-forget refresh) took the whole server down with it.

import { logLine } from "./errors.ts";

export interface ProcessGuards {
  rejection(reason: unknown): void;
  exception(err: unknown, origin?: string): void;
}

/** How long a crashing process waits for its last log lines to be written. */
const FLUSH_MS = 250;

export function processGuards(
  name: string,
  opts: { log?: (line: string) => void; exit?: (code: number) => void } = {},
): ProcessGuards {
  const log = opts.log ?? ((line: string) => console.error(line));
  const exit = opts.exit ?? ((code: number) => setTimeout(() => process.exit(code), FLUSH_MS));
  // Where it came from, without the stack's own copy of the message (which may hold a query's
  // values; logLine gives the safe version).
  const stack = (e: unknown) => {
    const frames =
      e instanceof Error ? (e.stack ?? "").split("\n").filter((l) => /^\s+at /.test(l)) : [];
    return frames.length ? `\n${frames.join("\n")}` : "";
  };
  const what = (e: unknown) =>
    `${e instanceof Error && e.name !== "Error" ? `${e.name}: ` : ""}${logLine(e)}${stack(e)}`;
  return {
    // Logged, and the process carries on: whatever failed was one task, not the process.
    rejection(reason) {
      log(`[${name}] a background task failed and nothing caught it: ${what(reason)}`);
    },
    // Something threw outside any handler, so the process may be in a state nothing expects.
    // It's logged and ends, and the service manager starts it afresh.
    exception(err, origin = "uncaughtException") {
      log(`[${name}] stopped by an unexpected error (${origin}): ${what(err)}`);
      process.exitCode = 1;
      exit(1);
    },
  };
}

let installed = false;

/** Installs the guards for this process. Safe to call more than once. */
export function guardProcess(name: string): void {
  if (installed) return;
  installed = true;
  const guards = processGuards(name);
  process.on("unhandledRejection", guards.rejection);
  process.on("uncaughtException", guards.exception);
}
