// An inbox row and what you can do to it besides opening it. An approval's card waiting for you
// can't be put away, as done or snoozed: it leaves the inbox only by a yes or a no (D58).

import { isWaiting } from "./approvals.ts";
import type { InboxRow } from "./types.ts";

export type InboxView = "live" | "snoozed" | "done";

/** An approval card still waiting for your yes or no (and not decided here a moment ago). */
export const waitingOnYou = (row: InboxRow | undefined) =>
  !!row?.notification.approvalId && isWaiting(row.notification.approvalId, row.approvalStatus);
export const NEEDS_DECISION = "This one needs a yes or a no first: press a or d.";

/**
 * A row's "more" menu: what e and s do, for a finger. An approval waiting for you isn't offered a
 * snooze at all: Hearth refuses it, and the card would blink out of the list and back first.
 */
export function rowMenu(
  row: InboxRow,
  view: InboxView,
  run: { done: () => void; snooze: () => void },
): { label: string; run: () => void }[] {
  return [
    { label: view === "done" ? "Not done" : "Done", run: run.done },
    ...(view === "live" && !waitingOnYou(row) ? [{ label: "Snooze…", run: run.snooze }] : []),
  ];
}

/**
 * An approval's inbox card in its three parts: what it would do (the title), why it needs your
 * yes, and exactly what would happen, such as an email's whole text. Hearth writes the body as
 * that text and then its reason, a sentence of its own, after a blank line (the kernel's
 * approvals.ts), so the last paragraph is the why and everything before it is the text, as is.
 */
export function approvalParts(n: Pick<InboxRow["notification"], "title" | "body">): {
  what: string;
  why: string | null;
  text: string | null;
} {
  const body = n.body ?? "";
  const cut = body.lastIndexOf("\n\n");
  return {
    what: n.title,
    why: (cut < 0 ? body : body.slice(cut + 2)).trim() || null,
    text: cut < 0 ? null : body.slice(0, cut) || null,
  };
}
