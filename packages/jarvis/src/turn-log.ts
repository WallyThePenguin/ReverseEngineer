// One JSON line per turn attempt (D54): when, what started it, which lane, how it ended, how
// long it took and how soon the first words came. The file rolls over at a size limit and a few
// old ones are kept, so it never fills the disk.
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

export interface TurnLogLine {
  at: string;
  turnId: string;
  trigger: string;
  lane: string;
  mode: string;
  /** done, failed, canceled, or retrying when it will be tried again. */
  status: string;
  attempt: number;
  errorKind: string | null;
  durationMs: number;
  firstTokenMs: number | null;
  tools: number;
}

export type TurnLog = (line: TurnLogLine) => void;

export interface TurnLogOptions {
  /** Roll over past this size. */
  maxBytes?: number;
  /** Old files kept: turns.jsonl.1 (newest) to turns.jsonl.N. */
  keep?: number;
  onError?: (err: unknown) => void;
}

export function fileTurnLog(file: string, opts: TurnLogOptions = {}): TurnLog {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const keep = opts.keep ?? 3;
  return (line) => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
      if (size >= maxBytes) {
        rmSync(`${file}.${keep}`, { force: true });
        for (let i = keep - 1; i >= 1; i--) {
          if (statSync(`${file}.${i}`, { throwIfNoEntry: false }))
            renameSync(`${file}.${i}`, `${file}.${i + 1}`);
        }
        renameSync(file, `${file}.1`);
      }
      appendFileSync(file, `${JSON.stringify(line)}\n`);
    } catch (err) {
      // A log that can't be written mustn't take a turn down with it.
      opts.onError?.(err);
    }
  };
}
