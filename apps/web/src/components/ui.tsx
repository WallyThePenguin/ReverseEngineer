// Small shared pieces: pane headers, empty states, buttons, badges.

import type { JSX } from "solid-js";
import { createContext, Show, useContext } from "solid-js";
import { layout } from "../lib/panes.ts";
import { moveToTrash, restore, TRASHABLE } from "../lib/trash.ts";
import { type MenuItem, Overflow } from "./Menu.tsx";

/** The record a pane shows, so its header can offer to move it to the trash. */
export interface PaneRecord {
  id: string;
  type: string;
  /** It's in the trash (some records still open from there): the header offers Restore. */
  trashed?: boolean;
}

/** Which pane a view is in, how to close it (when there's more than one), and its record. */
export const PaneContext = createContext<{
  close: (() => void) | null;
  record?: PaneRecord | undefined;
}>({ close: null });

/** Tells the pane's header which record is showing (the header can be drawn by an editor). */
export function ForRecord(props: { record: PaneRecord | undefined; children: JSX.Element }) {
  const pane = useContext(PaneContext);
  return (
    <PaneContext.Provider
      value={{
        get close() {
          return pane.close;
        },
        get record() {
          return props.record;
        },
      }}
    >
      {props.children}
    </PaneContext.Provider>
  );
}

/** Where you land after trashing the record a lone pane showed. */
const HOME: Record<string, Parameters<typeof layout.open>[0]> = {
  task: { view: "tasks" },
  note: { view: "notes" },
  canvas: { view: "canvases" },
  spreadsheet: { view: "sheets" },
  person: { view: "people" },
  company: { view: "people" },
  memory_note: { view: "memory" },
};

export function PaneHeader(props: {
  title: JSX.Element;
  children?: JSX.Element;
  sub?: JSX.Element;
  /** More actions, behind a ⋯ button. */
  menu?: MenuItem[];
  /** The record this pane shows: the menu offers to move it to the trash. */
  record?: PaneRecord | undefined;
}) {
  const pane = useContext(PaneContext);
  const record = () => {
    const r = props.record ?? pane.record;
    return r && TRASHABLE.has(r.type) ? r : undefined;
  };
  const items = (): MenuItem[] => {
    const r = record();
    if (!r) return props.menu ?? [];
    if (r.trashed) return [{ label: "Restore", run: () => void restore(r.id) }];
    return [
      ...(props.menu ?? []),
      {
        label: "Move to trash",
        danger: true,
        run: async () => {
          if (!(await moveToTrash(r.id))) return;
          if (pane.close) pane.close();
          else layout.open(HOME[r.type] ?? { view: "inbox" });
        },
      },
    ];
  };
  return (
    <>
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
        <Show when={items().length > 0}>
          <Overflow items={items()} label="More actions" />
        </Show>
        <PaneClose />
      </header>
      <Show when={record()?.trashed && record()}>
        {(r) => (
          <p class="flex items-center gap-3 border-b border-line bg-accent-soft px-4 py-1.5 text-sm">
            <span class="flex-1">This is in the trash.</span>
            <Button small onClick={() => void restore(r().id)}>
              Restore
            </Button>
          </p>
        )}
      </Show>
    </>
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
  onClick?: (e: MouseEvent) => void;
  /** Submits its form (so Enter in any of the form's fields does too). */
  submit?: boolean;
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
      type={props.submit ? "submit" : "button"}
      class={`rounded-md font-medium disabled:opacity-50 ${props.small ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm"} ${tone()}`}
      disabled={props.disabled}
      title={props.title}
      onClick={(e) => props.onClick?.(e)}
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
