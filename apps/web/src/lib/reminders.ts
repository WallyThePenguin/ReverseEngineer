// A reminder in Settings → Coming up. One set after reading an email or a message doesn't show its
// words, as Jarvis's status doesn't: only that it was set that way, or that you asked for it in a
// conversation that had read one (Jarvis still wrote its words there).
import type { Reminder } from "./types.ts";

export function reminderLabel(r: Pick<Reminder, "text" | "setAfterOutsideContent" | "asked">) {
  if (!r.setAfterOutsideContent) return r.text;
  return r.asked ? "Reminder you asked for" : "Set from an email or a message";
}

/** What Cancel asks before it calls a reminder off: nothing brings it back. */
export const cancelQuestion = (r: Pick<Reminder, "when">) =>
  `Cancel the reminder for ${r.when}? It won't ring, and it can't be brought back.`;
