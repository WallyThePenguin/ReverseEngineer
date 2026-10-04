// A row of big buttons along the bottom of a pane on a phone, where the thumb is: what the keys
// do on a computer (archive, star, reply). On a computer the header's buttons and keys do it.

import { For, Show } from "solid-js";
import { narrow } from "../lib/narrow.ts";

export interface BarAction {
  label: string;
  run: () => void;
  /** Shown pressed (a star that's on). */
  on?: boolean;
}

export function ActionBar(props: { label: string; actions: BarAction[] }) {
  return (
    <Show when={narrow()}>
      <nav class="flex shrink-0 border-t border-line bg-panel" aria-label={props.label}>
        <For each={props.actions}>
          {(a) => (
            <button
              type="button"
              class="min-h-12 flex-1 px-1 text-sm font-medium text-ink active:bg-sunk"
              classList={{ "text-accent": a.on }}
              aria-pressed={a.on === undefined ? undefined : a.on}
              onClick={() => a.run()}
            >
              {a.label}
            </button>
          )}
        </For>
      </nav>
    </Show>
  );
}
