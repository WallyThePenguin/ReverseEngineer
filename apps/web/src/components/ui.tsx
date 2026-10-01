// Small shared pieces: pane headers, empty states, buttons, badges.

import type { JSX } from "solid-js";
import { createContext, Show, useContext } from "solid-js";

/** Which pane a view is in, and how to close it (when there's more than one). */
export const PaneContext = createContext<{ close: (() => void) | null }>({ close: null });

export function PaneHeader(props: {
  title: JSX.Element;
  children?: JSX.Element;
  sub?: JSX.Element;
}) {
  return (
    <header class="flex min-h-12 items-start gap-2 border-b border-line px-4 py-2">
      <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
        <div class="min-w-24 flex-1">
          <h1 class="truncate text-base font-semibold">{props.title}</h1>
          <Show when={props.sub}>
            <p class="truncate text-xs text-muted">{props.sub}</p>
          </Show>
        </div>
        {props.children}
      </div>
      <PaneClose />
    </header>
  );
}

function PaneClose() {
  const pane = useContext(PaneContext);
  return (
    <Show when={pane.close}>
      <button
        type="button"
        class="-mr-2 rounded px-1.5 text-lg leading-none text-faint hover:bg-sunk hover:text-ink"
        title="Close pane (Alt+W)"
        onClick={(e) => {
          e.stopPropagation();
          pane.close?.();
        }}
      >
        ×
      </button>
    </Show>
  );
}

export function Empty(props: { children: JSX.Element }) {
  return <p class="px-4 py-10 text-center text-sm text-muted">{props.children}</p>;
}

/** A record pane that's loading, or whose record is gone. Keeps the header so it can be closed. */
export function Placeholder(props: { missing: boolean; what: string }) {
  return (
    <div class="flex h-full flex-col">
      <PaneHeader title={props.missing ? "Not found" : ""} />
      <Empty>
        {props.missing ? `This ${props.what} doesn't exist or was deleted.` : "Loading…"}
      </Empty>
    </div>
  );
}

export function Button(props: {
  onClick: (e: MouseEvent) => void;
  children: JSX.Element;
  kind?: "primary" | "plain" | "danger" | "jarvis";
  disabled?: boolean;
  title?: string;
  small?: boolean;
}) {
  const tone = () =>
    ({
      primary: "bg-accent text-white",
      plain: "border border-line bg-panel hover:bg-sunk",
      danger: "border border-line bg-panel text-bad hover:bg-sunk",
      jarvis: "bg-jarvis text-white dark:text-[#15130f]",
    })[props.kind ?? "plain"];
  return (
    <button
      type="button"
      class={`rounded-md font-medium disabled:opacity-50 ${props.small ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm"} ${tone()}`}
      disabled={props.disabled}
      title={props.title}
      onClick={(e) => props.onClick(e)}
    >
      {props.children}
    </button>
  );
}

export function Badge(props: {
  children: JSX.Element;
  tone?: "jarvis" | "warn" | "bad" | "ok" | "muted";
}) {
  const tone = () =>
    ({
      jarvis: "bg-jarvis-soft text-jarvis",
      warn: "bg-accent-soft text-warn",
      bad: "bg-accent-soft text-bad",
      ok: "bg-sunk text-ok",
      muted: "bg-sunk text-muted",
    })[props.tone ?? "muted"];
  return (
    <span class={`rounded px-1.5 py-0.5 text-[11px] font-medium ${tone()}`}>{props.children}</span>
  );
}

export function Kbd(props: { children: JSX.Element }) {
  return (
    <kbd class="rounded border border-line bg-sunk px-1 font-mono text-[11px] text-muted">
      {props.children}
    </kbd>
  );
}
