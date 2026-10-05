// What a screen shows while its read is on the way: grey bars the shape of what's coming, so the
// page doesn't jump when it lands. They wait a moment before showing, since most reads answer
// sooner and a flash of bars is worse than a blank moment. A screen reader hears "Loading…" at
// once, as it always did.

import { createSignal, For, onCleanup, Show } from "solid-js";

/** How long a read has before its skeleton shows. */
export const SKELETON_DELAY_MS = 250;

/** How wide each bar is, in turn, so the rows don't look ruled. */
const WIDTHS = [72, 54, 66, 48, 80, 60];

export function Skeleton(props: {
  /** Rows of a list (the default), or the top of a record: a title, then lines of text. */
  kind?: "rows" | "record";
  /** How many rows or lines: 6 by default. */
  count?: number;
  class?: string;
}) {
  const [shown, setShown] = createSignal(false);
  const timer = window.setTimeout(() => setShown(true), SKELETON_DELAY_MS);
  onCleanup(() => window.clearTimeout(timer));
  const lines = () =>
    Array.from({ length: props.count ?? 6 }, (_, i) => WIDTHS[i % WIDTHS.length]!);
  return (
    <div class={props.class}>
      <span class="sr-only">Loading…</span>
      <Show when={shown()}>
        <div aria-hidden="true" class="animate-pulse">
          <Show
            when={props.kind === "record"}
            fallback={
              <For each={lines()}>
                {(width) => (
                  <div class="flex min-h-14 items-center gap-3 border-b border-line px-4 md:min-h-10">
                    <span class="size-4 shrink-0 rounded-sm bg-line" />
                    <span class="h-3 rounded-full bg-line" style={{ width: `${width}%` }} />
                  </div>
                )}
              </For>
            }
          >
            <div class="space-y-3 p-4">
              <div class="h-5 w-2/5 rounded-full bg-line" />
              <For each={lines()}>
                {(width) => <div class="h-3 rounded-full bg-line" style={{ width: `${width}%` }} />}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
