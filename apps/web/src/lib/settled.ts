// What a button acts on is what you had time to see. A list or a draft that changes under a button
// arms it again only once it has stayed the same for a moment, so a tap never covers something
// that arrived (or changed) just before it, below the fold or while you were reading.

import { createEffect, createSignal, on, onCleanup, untrack } from "solid-js";

/** How long a change has to stay put before a button takes it on. */
export const SETTLE_MS = 1500;

export function createSettled<T>(
  read: () => T,
  opts: {
    /** Whether two values are the same, as far as the button is concerned. */
    same: (a: T, b: T) => boolean;
    /** A change the button may take on at once, such as an item leaving the list it covers. */
    safe?: (armed: T, next: T) => boolean;
    /** What it covers to begin with, when not what's there now (nothing, for what just came). */
    initial?: T;
    ms?: number;
  },
): {
  /** What the button acts on: what's shown, once it has stayed put. */
  armed: () => T;
  /** It changed a moment ago and the button waits for it to stay put. */
  settling: () => boolean;
  /** It changed while it was shown, at least once. */
  changed: () => boolean;
} {
  const [armed, setArmed] = createSignal<T>(
    "initial" in opts ? (opts.initial as T) : untrack(read),
  );
  const [settling, setSettling] = createSignal(false);
  const [changed, setChanged] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  createEffect(
    on(read, (next) => {
      stop();
      const current = untrack(armed);
      if (opts.same(current, next)) return setSettling(false);
      if (opts.safe?.(current, next)) {
        setArmed(() => next);
        return setSettling(false);
      }
      setChanged(true);
      setSettling(true);
      timer = setTimeout(() => {
        timer = undefined;
        setArmed(() => untrack(read));
        setSettling(false);
      }, opts.ms ?? SETTLE_MS);
    }),
  );
  onCleanup(stop);
  return { armed, settling, changed };
}

/** Two lists of ids hold the same ids, in any order. */
export const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && b.every((id) => a.includes(id));

/** Every id in `next` was already in `armed`: some left, none arrived. */
export const noneNew = (armed: readonly string[], next: readonly string[]) =>
  next.every((id) => armed.includes(id));
