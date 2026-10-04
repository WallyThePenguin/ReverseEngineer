// The trash: what you (or Jarvis) moved there, newest first, and a way to bring each back with
// everything that went with it. Notion imports can be undone from here too.

import { For, Show } from "solid-js";
import { Badge, Button, Empty, PaneHeader } from "../components/ui.tsx";
import { ago, TYPE_LABEL, who } from "../lib/format.ts";
import { listKeys, useHotkeys } from "../lib/hotkeys.ts";
import { layout } from "../lib/panes.ts";
import { useAction } from "../lib/query.ts";
import { createSelection } from "../lib/selection.ts";
import { restore } from "../lib/trash.ts";

export interface TrashRow {
  id: string;
  type: string;
  title: string;
  deletedAt: string;
  deletedBy: string;
  withIt: number;
}

export function Trash(props: { pane: number }) {
  const rows = useAction<TrashRow[]>("entity.trashed", () => ({ limit: 100 }));
  const list = () => rows.data ?? [];
  const sel = createSelection(list, (r) => r.id);
  const focused = () => layout.focused() === props.pane;
  const bringBack = (r: TrashRow | undefined) => r && void restore(r.id);

  useHotkeys([
    ...listKeys({
      count: () => list().length,
      index: sel.index,
      setIndex: sel.select,
      when: focused,
    }),
    { keys: "r", run: () => bringBack(sel.current()), when: focused, label: "Restore" },
    { keys: "enter", run: () => bringBack(sel.current()), when: focused },
  ]);

  return (
    <div class="flex h-full flex-col">
      <PaneHeader title="Trash" sub="Restore brings back what went with it, too" />
      <div class="flex-1 overflow-auto">
        <Show
          when={list().length > 0}
          fallback={
            <Empty>
              {rows.isLoading
                ? "Loading…"
                : rows.isError
                  ? "Couldn't load the trash."
                  : "Nothing in the trash. What you move there shows here, ready to restore."}
            </Empty>
          }
        >
          <ul>
            <For each={list()}>
              {(r, i) => (
                <li
                  class="flex items-center gap-3 border-b border-line py-1.5 pr-2 pl-4"
                  data-active={focused() && i() === sel.index()}
                  onClick={() => sel.select(i())}
                >
                  <div class="min-w-0 flex-1">
                    <p class="truncate">
                      {r.title || (r.type === "comment" ? "A comment" : "Untitled")}
                    </p>
                    <p class="truncate text-xs text-muted">
                      {who(r.deletedBy)} · {ago(r.deletedAt)}
                      {r.withIt
                        ? ` · with ${r.withIt} record${r.withIt === 1 ? "" : "s"} under it`
                        : ""}
                    </p>
                  </div>
                  <Badge>{TYPE_LABEL[r.type] ?? r.type}</Badge>
                  <Button small onClick={() => bringBack(r)} title="Restore (r)">
                    Restore
                  </Button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </div>
  );
}
