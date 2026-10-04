// The row the keyboard is on in a list, kept by the row's id rather than its position. A live
// refresh that adds rows above it doesn't move it onto a different item, so a quick e, a or #
// acts on the row you're looking at. When its row goes (done, archived, trashed), the
// selection moves to the row that took its place, and that row is the one highlighted.

import { createEffect, createMemo, createSignal } from "solid-js";

/** Where the selection is: its id's row, or once that's gone, the row now at its old place. */
export function resolveIndex(
  ids: readonly string[],
  selected: string | null,
  last: number,
): number {
  if (ids.length === 0) return -1;
  const at = selected === null ? -1 : ids.indexOf(selected);
  return at >= 0 ? at : Math.max(0, Math.min(last, ids.length - 1));
}

export interface Selection<T> {
  /** The selected row's position, or -1 when the list is empty. */
  index: () => number;
  /** The selected row. */
  current: () => T | undefined;
  /** Selects the row at a position (j/k, a click). */
  select: (i: number) => void;
  /** Back to the top, for a list that's about to show something else. */
  reset: () => void;
}

export function createSelection<T>(
  list: () => readonly T[],
  idOf: (item: T) => string,
): Selection<T> {
  const [selected, setSelected] = createSignal<string | null>(null);
  const [last, setLast] = createSignal(0);
  const ids = createMemo(() => list().map(idOf));
  const index = createMemo(() => resolveIndex(ids(), selected(), last()));
  /** The rows shown when the list was reset: the top of the list that replaces them is next. */
  let replaced: readonly string[] | null = null;
  // The row that took a gone row's place becomes the selection, so it stays put from then on.
  createEffect(() => {
    const i = index();
    const now = ids();
    if (i < 0 || now === replaced) return;
    replaced = null;
    setLast(i);
    const id = now[i];
    if (id !== undefined && id !== selected()) setSelected(id);
  });
  return {
    index,
    current: () => list()[index()],
    select(i) {
      replaced = null;
      setLast(Math.max(0, i));
      setSelected(ids()[i] ?? null);
    },
    reset() {
      replaced = ids();
      setLast(0);
      setSelected(null);
    },
  };
}
