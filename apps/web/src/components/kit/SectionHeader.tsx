// A section's or a card's heading: its name, how many there are, and a way to the whole list
// ("All ▸"). Hierarchy comes from weight and space, not ever smaller capitals (D65).

import { type JSX, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Icon } from "../icons.tsx";

export function SectionHeader(props: {
  title: JSX.Element;
  /** How many there are, beside the name; nothing when there are none. */
  count?: number;
  /** The whole list: "All" by default, or its own words ("All 12 updates"). */
  more?: { label?: string; run: () => void };
  /** A small button or two before "All". */
  children?: JSX.Element;
  /** For the card or section it heads to name itself by (aria-labelledby). */
  id?: string;
  /** h2 by default; h3 inside a section that has one. */
  level?: 2 | 3;
  class?: string;
}) {
  return (
    <div class={`flex min-h-8 items-center gap-2 ${props.class ?? ""}`}>
      <Dynamic component={props.level === 3 ? "h3" : "h2"} id={props.id} class="text-heading">
        {props.title}
      </Dynamic>
      <Show when={props.count}>
        {(count) => <span class="text-meta text-muted tabular-nums">{count()}</span>}
      </Show>
      <span class="flex-1" />
      {props.children}
      <Show when={props.more}>
        {(more) => (
          <button
            type="button"
            class="-mr-1 inline-flex min-h-11 items-center gap-0.5 rounded-md px-1 text-meta font-medium text-muted hover:bg-sunk hover:text-ink md:min-h-7"
            onClick={() => more().run()}
          >
            {more().label ?? "All"}
            <Icon name="chevron-right" size={14} />
          </button>
        )}
      </Show>
    </div>
  );
}
