// The due date a quick-add box read from what you typed, shown before you add it: "Due Fri 3 p.m."
// Clicking it leaves the date off this entry, so a misread never sticks (lib/when.ts).

import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { due } from "../lib/format.ts";
import { readWhen, taskFields } from "../lib/when.ts";
import { Icon } from "./icons.tsx";
import { Pill } from "./kit/Pill.tsx";

/** A box's date: what it read, taking it off, and what to make on Enter. */
export function useWhen(text: () => string) {
  const [off, setOff] = createSignal(false);
  // Taken off for this entry only: an empty box starts reading dates again.
  createEffect(() => {
    if (!text().trim()) setOff(false);
  });
  const when = createMemo(() => (off() ? null : readWhen(text().trim())));
  return {
    when,
    takeOff: () => setOff(true),
    /**
     * Makes the task's fields from what was typed, the date kept or left off as it is now: asked
     * before the box clears, since clearing it starts reading dates again.
     */
    fields: () => {
      const keep = !off();
      return (typed: string) => taskFields(typed, keep);
    },
  };
}

export function WhenChip(props: { box: ReturnType<typeof useWhen> }) {
  return (
    <Show when={props.box.when()}>
      {(w) => (
        <Pill
          tone="accent"
          icon="calendar"
          title="Read from what you typed. Click to leave the date off."
          onClick={() => props.box.takeOff()}
        >
          Due {due(w().dueAt, w().dueIsDate)?.text}
          <Icon name="x" size={12} label="Leave the date off" />
        </Pill>
      )}
    </Show>
  );
}
