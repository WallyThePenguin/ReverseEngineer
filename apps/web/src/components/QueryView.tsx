// One read's states, the same on every screen: loading, failed with Try again, empty, or the data.
// Data already shown stays while a refresh fails; the live banner says when Hearth is out of reach.

import { type Accessor, type JSX, Show, untrack } from "solid-js";
import { Empty, Failed, type Read } from "./ui.tsx";

export interface QueryRead<T> extends Read {
  data: T | undefined;
}

/**
 * What a list shows instead of rows: loading, couldn't load (with Try again), or its own empty
 * text. For lists that draw their rows themselves; never "nothing here" when the read failed.
 */
export function NoRows(props: { query: QueryRead<unknown>; what: string; children: JSX.Element }) {
  return (
    <Show when={props.query.data === undefined} fallback={<Empty>{props.children}</Empty>}>
      <Show when={props.query.isError} fallback={<Empty>Loading…</Empty>}>
        <Failed error={props.query.error} retry={props.query.refetch} what={props.what} />
      </Show>
    </Show>
  );
}

export function QueryView<T>(props: {
  query: QueryRead<T>;
  /** What failed to load, as in "Couldn't load your devices". */
  what: string;
  /** Whether the data counts as nothing to show; by default, an empty list. */
  isEmpty?: (data: T) => boolean;
  /** Shown when there's nothing; without it the children draw the empty case themselves. */
  empty?: JSX.Element;
  /** Shown while loading; "Loading…" by default. */
  loading?: JSX.Element;
  /** Drawn once; `data` follows later refreshes, so what's on screen keeps its state. */
  children: (data: Accessor<T>) => JSX.Element;
}) {
  const data = () => props.query.data as T;
  const empty = () => {
    if (props.empty === undefined) return false;
    const d: unknown = data();
    return props.isEmpty ? props.isEmpty(d as T) : Array.isArray(d) && d.length === 0;
  };
  return (
    <Show
      when={props.query.data !== undefined}
      fallback={
        <Show when={props.query.isError} fallback={props.loading ?? <Empty>Loading…</Empty>}>
          <Failed error={props.query.error} retry={props.query.refetch} what={props.what} />
        </Show>
      }
    >
      <Show when={!empty()} fallback={props.empty}>
        {untrack(() => props.children(data))}
      </Show>
    </Show>
  );
}
