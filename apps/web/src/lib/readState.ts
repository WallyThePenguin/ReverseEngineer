// What a failed read means for the screen: gone for good, worth another try, or out of reach.

/** Answers that won't change if asked again, so they aren't retried. */
const FINAL = new Set(["not_found", "invalid_input", "forbidden", "denied", "unknown_action"]);

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/** The record isn't there (or isn't yours to see): say so instead of "try again". */
export function isMissing(error: unknown): boolean {
  return codeOf(error) === "not_found";
}

/** Whether a failed read is worth one more automatic try. */
export function retryRead(failures: number, error: unknown): boolean {
  return failures < 1 && !FINAL.has(codeOf(error) ?? "");
}

/** A failed read in a sentence: Hearth's own words when it gave some. */
export function failedMessage(error: unknown, what: string): string {
  const e = error as { code?: unknown; message?: unknown } | null;
  const said = typeof e?.message === "string" ? e.message.trim() : "";
  if (codeOf(error) === "unreachable" && said) return said;
  if (!said) return `Couldn't load ${what}.`;
  return `Couldn't load ${what}: ${said}${/[.!?]$/.test(said) ? "" : "."}`;
}
