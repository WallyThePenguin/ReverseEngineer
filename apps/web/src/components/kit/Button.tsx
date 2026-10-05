// A button with words on it, and optionally an icon before them. components/ui.tsx re-exports it,
// so it's imported from there as it always was; it lives here so the pane header can use it too.

import { type JSX, Show } from "solid-js";
import { Icon, type IconName } from "../icons.tsx";

export function Button(props: {
  onClick?: (e: MouseEvent) => void;
  /** Submits its form (so Enter in any of the form's fields does too). */
  submit?: boolean;
  children: JSX.Element;
  kind?: "primary" | "plain" | "danger" | "jarvis";
  disabled?: boolean;
  title?: string;
  /** What a screen reader says, when the button shows only a symbol. */
  label?: string;
  /** Drawn before its text. */
  icon?: IconName;
  small?: boolean;
}) {
  const tone = () =>
    ({
      primary: "bg-accent text-on-fill",
      plain: "border border-line bg-panel hover:bg-sunk",
      danger: "border border-line bg-panel text-bad hover:bg-sunk",
      jarvis: "bg-jarvis text-on-fill",
    })[props.kind ?? "plain"];
  return (
    <button
      type={props.submit ? "submit" : "button"}
      // A fingertip needs 44 px; a pointer doesn't.
      class={`inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md font-medium disabled:opacity-50 md:min-h-0 ${props.small ? "px-3 text-sm md:px-2 md:py-0.5 md:text-xs" : "px-3 py-1 text-sm"} ${tone()}`}
      disabled={props.disabled}
      title={props.title}
      aria-label={props.label}
      onClick={(e) => props.onClick?.(e)}
    >
      <Show when={props.icon}>{(name) => <Icon name={name()} size={props.small ? 14 : 16} />}</Show>
      {props.children}
    </button>
  );
}
