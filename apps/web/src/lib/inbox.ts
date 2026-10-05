// An inbox row and what you can do to it besides opening it. An approval's card waiting for you
// can't be put away, as done or snoozed: it leaves the inbox only by a yes or a no (D58).

import { isDecided } from "./approvals.ts";
import type { InboxRow } from "./types.ts";

export type InboxView = "live" | "snoozed" | "done";

/** An approval card still waiting for your yes or no (and not decided here a moment ago). */
export const waitingOnYou = (row: InboxRow | undefined) =>
  !!row?.notification.approvalId &&
  row.approvalStatus === "pending" &&
  !isDecided(row.notification.approvalId);
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
