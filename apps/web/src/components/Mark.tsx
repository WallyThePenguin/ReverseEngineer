// Hearth's own marks: the flame, which stands for Hearth itself as on its app icon
// (public/icon.svg), and Jarvis's mark, an indigo circle that shows how Jarvis is doing.

import { Show } from "solid-js";

/** The flame of public/icon.svg, in its 32 by 32 box. */
const FLAME =
  "M16 7c3 4 6 6.5 6 11a6 6 0 0 1-12 0c0-2.5 1.2-4.3 2.6-5.6.2 1.8 1 3 2.4 3.6-.4-3.3.4-6.3 1-9z";

/**
 * Hearth's flame. On its ember tile it's the app icon, the same in light and dark mode; without
 * the tile it's drawn in the text's colour.
 */
export function Flame(props: { size?: number; tile?: boolean; class?: string }) {
  const tile = () => props.tile !== false;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      // The bare flame fills its box; on the tile it sits as on the app icon.
      viewBox={tile() ? "0 0 32 32" : "6.5 6 19 19"}
      width={props.size ?? 20}
      height={props.size ?? 20}
      class={`shrink-0 ${props.class ?? ""}`}
      aria-hidden="true"
    >
      <Show when={tile()} fallback={<path d={FLAME} fill="currentColor" />}>
        <rect width="32" height="32" rx="8" fill="#c2410c" />
        <path d={FLAME} fill="#fff" />
      </Show>
    </svg>
  );
}

/** How Jarvis is: at rest, working, hearing you, paused by you, or not running. */
export type JarvisState = "idle" | "thinking" | "listening" | "paused" | "down";

/**
 * Jarvis's mark: an indigo circle with a bright core. It pulses while Jarvis works, is ringed in
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
