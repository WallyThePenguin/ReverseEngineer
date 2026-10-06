// A notice: how Hearth is, said with a tone and its icon, so an outage, a warning and good news
// never look alike (D65). It floats over the app (Reconnecting, an update) or runs across a pane
// under its header (this is in the trash).

import { type JSX, Show } from "solid-js";
import { Icon, type IconName } from "../icons.tsx";

export type NoticeTone = "neutral" | "info" | "ok" | "warn" | "bad";

const BACK: Record<NoticeTone, string> = {
  neutral: "bg-raised",
  info: "bg-info-soft",
  ok: "bg-ok-soft",
  warn: "bg-warn-soft",
  bad: "bg-bad-soft",
};
const ICON: Record<NoticeTone, { name: IconName; class: string }> = {
  neutral: { name: "info", class: "text-muted" },
  info: { name: "info", class: "text-info" },
  ok: { name: "ok", class: "text-ok" },
  warn: { name: "warn", class: "text-warn" },
  bad: { name: "bad", class: "text-bad" },
};

export function Notice(props: {
  tone?: NoticeTone;
  children: JSX.Element;
  /** In place of the tone's own icon. */
  icon?: IconName;
  /** Turns the icon, while something's under way ("Reconnecting…"). */
  spin?: boolean;
  /** A button or two at the end: Reload, Restore. */
  action?: JSX.Element;
  /** Floats over the app (the default), or runs across a pane as a strip. */
  strip?: boolean;
  /**
   * A floating notice is a "status", read out when it's convenient; "alert" is read out at once.
   * A strip is part of its pane, read with it.
   */
  role?: "status" | "alert";
  class?: string;
}) {
  const tone = () => props.tone ?? "neutral";
  const look = () =>
    props.strip
      ? `border-b border-line px-4 py-1.5 ${tone() === "neutral" ? "bg-sunk" : BACK[tone()]}`
      : `max-w-[min(36rem,calc(100vw-2rem))] animate-enter rounded-lg px-3 py-2 shadow-pop ${BACK[tone()]}`;
  return (
    <div
      role={props.role ?? (props.strip ? undefined : "status")}
      class={`flex items-center gap-2.5 text-sm text-ink ${look()} ${props.class ?? ""}`}
    >
      <Icon
        name={props.icon ?? ICON[tone()].name}
        size={16}
        class={`${ICON[tone()].class} ${props.spin ? "animate-spin" : ""}`}
      />
      <span class="min-w-0 flex-1">{props.children}</span>
      {/* The shell's notices let clicks through to the page; their buttons take them. */}
      <Show when={props.action}>
        {(action) => <div class="pointer-events-auto flex shrink-0 gap-2">{action()}</div>}
      </Show>
    </div>
  );
}
