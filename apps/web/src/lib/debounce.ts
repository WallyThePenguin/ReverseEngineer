import { type Accessor, createEffect, createSignal, on, onCleanup, untrack } from "solid-js";

/** How long typing must pause before a search goes out. */
export const TYPING_PAUSE_MS = 150;

/**
 * Typed text, once typing has paused, so a search runs for what you meant rather than for every
 * letter on the way. Clearing it shows at once.
 */
export function debounced(source: Accessor<string>, ms = TYPING_PAUSE_MS): Accessor<string> {
  const [value, setValue] = createSignal(untrack(source));
  let timer: number | undefined;
  createEffect(
    on(
      source,
      (v) => {
        window.clearTimeout(timer);
        if (!v.trim()) setValue(v);
        else timer = window.setTimeout(() => setValue(v), ms);
      },
      { defer: true },
    ),
  );
  onCleanup(() => window.clearTimeout(timer));
  return value;
}
