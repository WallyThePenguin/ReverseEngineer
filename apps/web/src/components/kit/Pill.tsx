// A small rounded label: who a task is for, when it's due, how Jarvis is. A pill that says how
// something is (ok, warn, bad) always carries its icon, so its colour is never the only sign and a
// green tile is never mistaken for "ok" (D65). With onClick it's a button.

import { type JSX, Show } from "solid-js";
import { Icon, type IconName } from "../icons.tsx";

export type PillTone = "neutral" | "accent" | "jarvis" | "ok" | "warn" | "bad";

const TONE: Record<PillTone, string> = {
  neutral: "bg-sunk text-muted",
  accent: "bg-accent-soft text-accent",
  jarvis: "bg-jarvis-soft text-jarvis",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
};

/** A status's own icon, for a pill that doesn't name one. */
const STATUS_ICON: Partial<Record<PillTone, IconName>> = { ok: "ok", warn: "warn", bad: "bad" };

export function Pill(props: {
  children: JSX.Element;
  tone?: PillTone;
  /** Before the text; a status pill has its status's icon unless this names another. */
  icon?: IconName;
  onClick?: (e: MouseEvent) => void;
  title?: string;
  class?: string;
}) {
  const tone = () => props.tone ?? "neutral";
  const icon = () => props.icon ?? STATUS_ICON[tone()];
  const look = () =>
    `inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-meta font-medium ${TONE[tone()]} ${props.class ?? ""}`;
  const inside = () => (
    <>
      <Show when={icon()}>{(name) => <Icon name={name()} size={12} />}</Show>
      {props.children}
    </>
  );
  return (
    <Show
      when={props.onClick}
      fallback={
        <span class={look()} title={props.title}>
          {inside()}
        </span>
      }
    >
      {(click) => (
        <button
          type="button"
          // A fingertip needs 44 px: the pill stays small, the place it takes taps doesn't.
          class={`${look()} relative before:absolute before:-inset-x-1 before:-inset-y-3 hover:brightness-95 md:before:hidden`}
          title={props.title}
          onClick={(e) => click()(e)}
        >
          {inside()}
        </button>
      )}
    </Show>
  );
}
