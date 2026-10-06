// A checkbox in Hearth's look: the browser's own box underneath, so it's a real checkbox to a
// screen reader, the keyboard and the tests, drawn over with a tick. Round for a task.

import { type JSX, Show } from "solid-js";
import { Icon } from "../icons.tsx";

export function Checkbox(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** What ticking it does, for a screen reader ("Complete T-12"), when no words sit beside it. */
  label?: string;
  /** Words beside the box, which name it ("For Jarvis"). */
  children?: JSX.Element;
  /** Round, for a task. */
  round?: boolean;
  disabled?: boolean;
  title?: string;
  /** Placement only (a margin); the look is the kit's. */
  class?: string;
}) {
  return (
    <label
      // A fingertip needs 44 px: the whole square around the box takes the tap on a phone.
      class={`inline-flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center gap-2 text-sm md:min-h-0 md:min-w-0 ${props.disabled ? "cursor-default opacity-50" : ""} ${props.class ?? ""}`}
      title={props.title}
      // A tick in a row doesn't open the row.
      onClick={(e) => e.stopPropagation()}
    >
      <span class="relative flex size-[18px] shrink-0">
        <input
          type="checkbox"
          class={`peer size-[18px] cursor-pointer appearance-none border-[1.5px] border-faint bg-panel transition-colors duration-(--duration-fast) checked:border-accent checked:bg-accent disabled:cursor-default ${props.round ? "rounded-full" : "rounded-sm"}`}
          aria-label={props.label}
          checked={props.checked}
          disabled={props.disabled}
          onChange={(e) => props.onChange(e.currentTarget.checked)}
        />
        <Icon
          name="check"
          size={14}
          class="pointer-events-none absolute inset-0 m-auto hidden stroke-[2.5] text-on-fill peer-checked:block"
        />
      </span>
      <Show when={props.children}>{(text) => <span>{text()}</span>}</Show>
    </label>
  );
}
