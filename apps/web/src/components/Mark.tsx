// Nook's own marks: the Nook mark, which stands for Nook itself as on its app icon
// (public/icon.svg, design/nook/assets/Logos), and the agent's mark, a circle that shows how the
// agent is doing.

import { Show } from "solid-js";

/** The Light theme's accent, which Nook's mark keeps in every theme. */
const MARK_BLUE = "#0a60c8";

/**
 * Nook's mark: two windows, the front one Pip's face, on the accent tile. It's baked to the Light
 * theme's accent and stays blue on dark surfaces; never recoloured or outlined.
 */
export function NookMark(props: { size?: number; class?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      width={props.size ?? 20}
      height={props.size ?? 20}
      class={`shrink-0 ${props.class ?? ""}`}
      aria-hidden="true"
    >
      <rect width="64" height="64" rx="16" fill={MARK_BLUE} />
      <rect x="10" y="12" width="30" height="26" rx="7" fill="#fff" opacity=".4" />
      <rect x="22" y="24" width="32" height="28" rx="8" fill="#fff" />
      <circle cx="33" cy="37" r="3.5" fill={MARK_BLUE} />
      <circle cx="43" cy="37" r="3.5" fill={MARK_BLUE} />
      <path
        d="M36 44q2 2 4 0"
        fill="none"
        stroke={MARK_BLUE}
        stroke-width="2"
        stroke-linecap="round"
      />
    </svg>
  );
}

/** How Jarvis is: at rest, working, hearing you, paused by you, or not running. */
export type JarvisState = "idle" | "thinking" | "listening" | "paused" | "down";

/**
 * Jarvis's mark: an ember circle with a bright core. It pulses while Jarvis works, is ringed in
 * red while it listens, greys while paused, and carries a red dot while it isn't running. It
 * stands for Jarvis wherever Jarvis is named; `label` says its state to a screen reader when no
 * text beside it does.
 */
export function JarvisMark(props: {
  state?: JarvisState;
  size?: number;
  class?: string;
  label?: string;
}) {
  const state = () => props.state ?? "idle";
  const size = () => props.size ?? 16;
  return (
    <>
      <span
        aria-hidden="true"
        class={`relative inline-flex shrink-0 items-center justify-center rounded-full ${state() === "paused" ? "bg-faint" : "bg-jarvis"} ${props.class ?? ""}`}
        classList={{
          "animate-pulse": state() === "thinking",
          "ring-2 ring-bad ring-offset-1 ring-offset-panel": state() === "listening",
        }}
        style={{ width: `${size()}px`, height: `${size()}px` }}
      >
        <span class="size-[38%] rounded-full bg-on-fill" />
        <Show when={state() === "down"}>
          <span class="absolute -top-px -right-px size-[42%] rounded-full bg-bad ring-2 ring-panel" />
        </Show>
      </span>
      <Show when={props.label}>
        <span class="sr-only"> {props.label}</span>
      </Show>
    </>
  );
}

/**
 * The small dot on Jarvis's line mark, only when something isn't as usual: grey while you've
 * paused it, red while it's down. Running as it should, it has none, so the tab bar's only dots
 * are ones that ask for a look.
 */
const DOT: Partial<Record<JarvisState, string>> = {
  paused: "bg-faint",
  down: "bg-bad",
};

/**
 * Jarvis's mark drawn as a line icon, for the phone's tab bar: in the text's colour like the
 * other tabs' icons, so only the tab you're on stands out, with a dot on its corner only while
 * Jarvis is paused or down.
 */
export function JarvisGlyph(props: { state?: JarvisState; size?: number; class?: string }) {
  const size = () => props.size ?? 24;
  return (
    <span aria-hidden="true" class={`relative inline-flex shrink-0 ${props.class ?? ""}`}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        width={size()}
        height={size()}
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="3.25" fill="currentColor" stroke="none" />
      </svg>
      <Show when={DOT[props.state ?? "idle"]}>
        {(dot) => (
          <span class={`absolute top-0 right-0 size-2 rounded-full ring-2 ring-panel ${dot()}`} />
        )}
      </Show>
    </span>
  );
}
