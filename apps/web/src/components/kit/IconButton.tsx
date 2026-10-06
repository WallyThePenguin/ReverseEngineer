// A button that shows only an icon: closing a pane, a toolbar's tools. Its name is said to a
// screen reader and shown as its tooltip, since there are no words on it.

import { Icon, type IconName } from "../icons.tsx";

export function IconButton(props: {
  icon: IconName;
  /** What it does, in words: its name for a screen reader, and its tooltip. */
  label: string;
  /** A longer tooltip than its name, such as one with its key: "Close pane (Alt+W)". */
  title?: string;
  onClick?: (e: MouseEvent) => void;
  /** The icon's size: 18 by default, 16 in a row. */
  size?: number;
  /** For a tool that stays on: whether it's on. */
  pressed?: boolean;
  disabled?: boolean;
  /** Placement only (a margin); the look is the kit's. */
  class?: string;
}) {
  return (
    <button
      type="button"
      // A fingertip needs 44 px; a pointer needs 28.
      class={`flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-muted hover:bg-sunk hover:text-ink disabled:pointer-events-none disabled:opacity-50 aria-pressed:bg-sunk aria-pressed:text-ink md:min-h-7 md:min-w-7 ${props.class ?? ""}`}
      aria-label={props.label}
      title={props.title ?? props.label}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={(e) => props.onClick?.(e)}
    >
      <Icon name={props.icon} size={props.size ?? 18} />
    </button>
  );
}
