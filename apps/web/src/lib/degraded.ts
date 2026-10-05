// Hearth answers but can't do its job (its database is out of reach): screens keep what they last
// showed, so one banner says it may be out of date until a read works again. Hearth being out of
// reach altogether is the Reconnecting banner's job.

import { createRoot, createSignal } from "solid-js";

/**
 * Whether a failed read means Hearth itself is up but unwell: its database is out of reach (the
 * kernel's DATABASE_DOWN). "unavailable" alone isn't enough; Chrome being closed says that too.
 */
export function meansDegraded(error: unknown): boolean {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message.startsWith("Hearth's database isn't reachable");
}

export const degraded = createRoot(() => {
  const [on, setOn] = createSignal(false);
  return {
    on,
    /** A read failed: unwell if it says so. Other failures leave the state as it was. */
    failed(error: unknown) {
      if (meansDegraded(error)) setOn(true);
    },
    /** A read worked: Hearth is well again. */
    worked() {
      if (on()) setOn(false);
    },
  };
});
