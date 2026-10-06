// Small shared pieces: empty, loading and failed states, badges and keys. The pane header
// (PaneHeader.tsx) and the kit's Button are re-exported from here, as they always were.

import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { failedMessage, isMissing } from "../lib/readState.ts";
import { Button } from "./kit/Button.tsx";
import { EmptyState } from "./kit/EmptyState.tsx";
import { Skeleton } from "./kit/Skeleton.tsx";
import { PaneHeader } from "./PaneHeader.tsx";

export { Button } from "./kit/Button.tsx";
export { ForRecord, PaneContext, PaneHeader, type PaneRecord } from "./PaneHeader.tsx";

/** A screen with nothing in it, said in a sentence; EmptyState adds a tile, title and button. */
export function Empty(props: { children: JSX.Element }) {
  return <EmptyState>{props.children}</EmptyState>;
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
      <Show when={props.query.isError} fallback={<Skeleton kind="record" count={4} />}>
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

/**
 * A key. A `hint` beside what it does (a and d on Approve and Deny) isn't shown on a touch
 * screen, which has no keys to press.
 */
export function Kbd(props: { children: JSX.Element; hint?: boolean }) {
  return (
    <kbd
      class={`rounded-sm border border-line bg-sunk px-1 font-mono text-micro text-muted ${props.hint ? "pointer-coarse:hidden" : ""}`}
    >
      {props.children}
    </kbd>
  );
}
