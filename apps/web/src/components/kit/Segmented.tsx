// A row of choices of which one is on: a sub-product's tabs (Mine · Jarvis's · Done), a filter.
// It never changes shape: choosing one changes its colour, not its width, so nothing shifts under
// your pointer. Each choice is a button that says whether it's pressed, as the Tasks filters are.

import { For, Show } from "solid-js";
import { Icon, type IconName } from "../icons.tsx";

export interface Segment<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  /** How many there are, after the label; nothing when there are none. */
  count?: number;
}

export function Segmented<T extends string>(props: {
  options: readonly Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  /** What the choices are of, for a screen reader: "Show", "Which tasks". */
  label: string;
  class?: string;
}) {
  return (
    <fieldset
      aria-label={props.label}
      class={`inline-flex min-w-0 shrink-0 gap-0.5 rounded-md bg-sunk p-0.5 ${props.class ?? ""}`}
    >
      <For each={props.options}>
        {(option) => (
          <button
            type="button"
            aria-pressed={props.value === option.value}
            // A fingertip needs 44 px; a pointer needs 28.
            class="inline-flex min-h-11 items-center gap-1.5 rounded-[6px] px-3 text-sm font-medium text-muted transition-colors duration-(--duration-fast) hover:text-ink aria-pressed:bg-raised aria-pressed:text-ink aria-pressed:shadow-card md:min-h-7 md:px-2.5"
            onClick={() => props.onChange(option.value)}
          >
            <Show when={option.icon}>{(name) => <Icon name={name()} size={16} />}</Show>
            {option.label}
            <Show when={option.count}>
              {(count) => <span class="text-micro text-muted tabular-nums">{count()}</span>}
            </Show>
          </button>
        )}
      </For>
    </fieldset>
  );
}
