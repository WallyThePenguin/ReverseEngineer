// Small shared pieces: pane headers, empty states, buttons, badges.

import type { JSX } from "solid-js";
import { createContext, Show, useContext } from "solid-js";
import { listFor } from "../lib/apps.ts";
import { layout } from "../lib/panes.ts";
import { failedMessage, isMissing } from "../lib/readState.ts";
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
          // A lone pane can't close: it goes to the list the record was in, or the inbox.
          if (pane.close) pane.close();
          else layout.open({ view: listFor(r.type) ?? "inbox" });
        },
      },
    ];
  };
  return (
    <>
      <header class="flex min-h-12 items-start gap-2 border-b border-line px-4 py-2">
        <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <div class="min-w-24 flex-1">
            <h1 class="truncate text-title">{props.title}</h1>
            <Show when={props.sub}>
              <p class="truncate text-meta text-muted">{props.sub}</p>
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
        aria-label="Close pane"
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

/** The parts of a read that its loading, failed and missing states need. */
export interface Read {
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
}

/** A read that failed: what went wrong, and a way to try again. */
export function Failed(props: { error: unknown; retry: () => unknown; what: string }) {
  return (
    <div role="alert" class="space-y-3 px-4 py-10 text-center text-sm text-muted">
      <p>{failedMessage(props.error, props.what)}</p>
      <Button small onClick={() => void props.retry()}>
        Try again
      </Button>
    </div>
  );
}

/**
 * A record pane that's loading, couldn't load, or whose record is gone (only when Hearth says
 * not_found; a failure that might pass offers Try again). Keeps the header so it can be closed.
 */
export function Placeholder(props: { query: Read; what: string }) {
  const missing = () => props.query.isError && isMissing(props.query.error);
  return (
    <div class="flex h-full flex-col">
      <PaneHeader title={missing() ? "Not found" : ""} />
      <Show when={props.query.isError} fallback={<Empty>Loading…</Empty>}>
        <Show
          when={!missing()}
          fallback={<Empty>{`This ${props.what} doesn't exist or was deleted.`}</Empty>}
        >
          <Failed
            error={props.query.error}
            retry={props.query.refetch}
            what={`this ${props.what}`}
          />
        </Show>
      </Show>
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
  /** What a screen reader says, when the button shows only a symbol. */
  label?: string;
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
      class={`min-h-11 rounded-md font-medium disabled:opacity-50 md:min-h-0 ${props.small ? "px-3 text-sm md:px-2 md:py-0.5 md:text-xs" : "px-3 py-1 text-sm"} ${tone()}`}
      disabled={props.disabled}
      title={props.title}
      aria-label={props.label}
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
      warn: "bg-warn-soft text-warn",
      bad: "bg-bad-soft text-bad",
      ok: "bg-ok-soft text-ok",
      muted: "bg-sunk text-muted",
    })[props.tone ?? "muted"];
  return <span class={`rounded-sm px-1.5 py-0.5 text-micro ${tone()}`}>{props.children}</span>;
}

export function Kbd(props: { children: JSX.Element }) {
  return (
    <kbd class="rounded-sm border border-line bg-sunk px-1 font-mono text-micro text-muted">
      {props.children}
    </kbd>
  );
}
