// A card: something to decide or to take in at a glance (one of Today's sections, an approval, a
// connection's state, the top of a record), raised a little off its pane. What you work through
// one by one stays a list of rows (D65).

import type { JSX } from "solid-js";

export function Card(props: {
  children: JSX.Element;
  /** The id of the card's heading, which names it for a screen reader. */
  labelledby?: string;
  /** Leaves out the padding, for rows that run to the card's edges. */
  flush?: boolean;
  /** Placement only (a margin, a grid cell); the look is the kit's. */
  class?: string;
}) {
  return (
    <section
      aria-labelledby={props.labelledby}
      class={`rounded-lg bg-raised shadow-card ${props.flush ? "overflow-hidden" : "p-4"} ${props.class ?? ""}`}
    >
      {props.children}
    </section>
  );
}
