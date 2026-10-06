// A Jarvis turn in plain words, for the lists that show them: What Jarvis did and Today.

import type { Turn } from "./types.ts";

/** A line without markdown's marks: "- **Offsite prep** is ready" → "Offsite prep is ready". */
export const unmark = (line: string) =>
  line
    .replace(/^\s*(?:#+|[-*>]|\d+\.)\s*/, "")
    .replace(/[*_`]/g, "")
    .trim();

/** A reply as one plain paragraph, its lines run together. */
export const plainReply = (text: string) => text.split("\n").map(unmark).filter(Boolean).join(" ");

const ENDED: Record<string, string> = {
  act: "Did it",
  ask: "Asked you",
  tell: "Told you",
  note: "Noted",
  nothing: "Nothing to do",
};
const STATUS: Record<string, string> = {
  queued: "Waiting",
  running: "Working",
  failed: "Failed",
  canceled: "Stopped",
  skipped: "Skipped",
};

/** How a turn ended, in a word or two: "Asked you", "Nothing to do", "Failed". */
export function turnResult(t: Pick<Turn, "status" | "outcome">): string {
  if (t.status === "done") return (t.outcome && ENDED[t.outcome]) ?? "Done";
  return STATUS[t.status] ?? t.status;
}
