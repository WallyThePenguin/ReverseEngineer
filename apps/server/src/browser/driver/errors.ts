// The driver's failures, each with a reason Jarvis can act on (B1, D52): the thing is gone, is
// covered, changed its name, would send, a dialog is in the way, or you're using the tab.
import type { ActionErrorCode } from "@hearth/kernel";
import { BrowserError, reasonOf } from "@hearth/modules";

export type Reason =
  | "gone"
  | "covered"
  | "changed"
  | "disabled"
  | "would_send"
  | "refused"
  | "blocked"
  | "dialog_open"
  | "owner_in_control"
  | "not_found"
  | "invalid"
  | "timeout";

const CODES: Record<Reason, ActionErrorCode> = {
  gone: "not_found",
  covered: "conflict",
  changed: "conflict",
  disabled: "failed",
  would_send: "forbidden",
  refused: "forbidden",
  blocked: "forbidden",
  dialog_open: "conflict",
  owner_in_control: "conflict",
  not_found: "not_found",
  invalid: "invalid_input",
  timeout: "failed",
};

export function fail(reason: Reason, message: string): BrowserError {
  return new BrowserError(CODES[reason], message, reason);
}

export { reasonOf };

/** Chrome's words when a node, frame or script context is no longer there. */
const GONE =
  /No node with given id|Could not find node|Node is detached|No node found|Cannot find context|Execution context was destroyed|No frame|Frame with the given id was not found|Inspected target navigated|isn't on the page any more|Session with given id not found/i;

export const isGone = (err: unknown) =>
  reasonOf(err) === "gone" || GONE.test(err instanceof Error ? err.message : String(err));

/** A ref that's no longer on the page, in words that say what to do. */
export const goneRef = (ref: string) =>
  fail("gone", `${ref} isn't on the page any more. Read the page again (browser_read_page).`);
