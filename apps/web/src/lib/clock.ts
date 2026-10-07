// One clock for what's said as time from now: "5 min ago", "due in 10 min", late, paused until.
// It moves on at each minute, so those words move on by themselves. A list read again keeps its
// unchanged rows as they were (keepUnchanged.ts), so a refresh doesn't draw them again, and
// nothing else would.

import { type Accessor, createMemo, createSignal, getListener } from "solid-js";

const MINUTE = 60_000;
const [minute, setMinute] = createSignal(0);
let ticking = false;
const untilNextMinute = () => MINUTE - (Date.now() % MINUTE);
function tick() {
  setMinute((m) => m + 1);
  setTimeout(tick, untilNextMinute());
}

/** Now. Read where something is shown (in a row, a memo), it's worked out again each minute. */
export function timeNow(): Date {
  // It starts ticking with the first thing on screen that reads it.
  if (!ticking && getListener()) {
    ticking = true;
    setTimeout(tick, untilNextMinute());
  }
  minute();
  return new Date();
}

/**
 * The start of today, as a number that changes when the day does, not each minute. What's grouped
 * or keyed by day reads this, so the minute moving on draws none of it again.
 */
export function createToday(): Accessor<number> {
  return createMemo(() => {
    const d = timeNow();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  });
}
