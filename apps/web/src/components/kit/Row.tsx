// A list's row: 40 px with one line on a computer, 56 px with two on a phone (D65). Lists are for
// working through things one by one: mail, updates, tasks, docs, people. The list drives it with
// its keys (j/k, Enter); the row says which one the keyboard is on.

import { type JSX, Show } from "solid-js";

export function Row(props: {
  /** Before the text: an icon, an avatar or a checkbox. */
  lead?: JSX.Element;
  title: JSX.Element;
  /** The second line: who it's from, when, where. Beside the title on a computer. */
  meta?: JSX.Element;
  /** At the end: a time, a badge, a "more" button (Menu's ROW_MENU shows on hover). */
  end?: JSX.Element;
  /** The row the keyboard is on. */
  active?: boolean;
  /** Finished, as a done task: the title is struck through and quiet. */
  done?: boolean;
  /** Opens it; `beside` when Shift was held, to open it in a pane of its own. */
  onOpen?: (beside: boolean) => void;
  class?: string;
}) {
  return (
    <li
      class={`group flex min-h-14 items-center gap-3 border-b border-line py-2 pr-2 pl-4 md:min-h-10 md:py-1.5 ${props.onOpen ? "cursor-pointer hover:bg-sunk/60" : ""} ${props.class ?? ""}`}
      data-active={props.active}
      onClick={(e) => props.onOpen?.(e.shiftKey)}
    >
      {props.lead}
      <div class="flex min-w-0 flex-1 flex-col md:flex-row md:items-baseline md:gap-2">
        <span class={`truncate ${props.done ? "text-muted line-through" : ""}`}>{props.title}</span>
        <Show when={props.meta}>
          {(meta) => <span class="truncate text-meta text-muted">{meta()}</span>}
        </Show>
      </div>
      {props.end}
    </li>
  );
}
