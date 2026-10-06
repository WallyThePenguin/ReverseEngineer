// Canvas boards (PLAN.md section 8.6): a list, and a board per pane.

import { For, lazy, Show } from "solid-js";
import { Overflow, ROW_MENU } from "../components/Menu.tsx";
import { NoRows } from "../components/QueryView.tsx";
import { Button, ForRecord, PaneHeader } from "../components/ui.tsx";
import { ago } from "../lib/format.ts";
import { listKeys, useHotkeys } from "../lib/hotkeys.ts";
import { layout } from "../lib/panes.ts";
import { act, useAction } from "../lib/query.ts";
import { createSelection } from "../lib/selection.ts";
import { moveToTrash, trashKey } from "../lib/trash.ts";

// The board is only needed once one opens.
const Board = lazy(() => import("../canvas/Board.tsx").then((m) => ({ default: m.CanvasBoard })));

type Row = { id: string; title: string; updatedAt: string };

export async function newCanvas(pane: number) {
  const made = await act<{ id: string }>("canvas.create", { title: "Untitled board" });
  if (made) layout.open({ view: "canvas", id: made.id }, { pane });
}

export function Canvases(props: { pane: number }) {
  const boards = useAction<Row[]>("canvas.list", () => ({ limit: 100 }));
  const list = () => boards.data ?? [];
  const sel = createSelection(list, (r) => r.id);
  const focused = () => layout.focused() === props.pane;
  const open = (r: Row | undefined, beside = false) => {
    if (!r) return;
    if (beside) layout.open({ view: "canvas", id: r.id }, { beside: true });
    else layout.show({ view: "canvas", id: r.id }, props.pane);
  };

  useHotkeys([
    ...listKeys({
      count: () => list().length,
      index: sel.index,
      setIndex: sel.select,
      when: focused,
    }),
    { keys: "enter", run: () => open(sel.current()), when: focused, label: "Open board" },
    trashKey(sel.current, focused),
    { keys: "c", run: () => void newCanvas(props.pane), when: focused, label: "New board" },
  ]);

  return (
    <div class="flex h-full flex-col">
      <PaneHeader title="Boards">
        <Button kind="primary" small onClick={() => void newCanvas(props.pane)}>
          New board
        </Button>
      </PaneHeader>
      <div class="flex-1 overflow-auto">
        <Show
          when={list().length > 0}
          fallback={
            <NoRows query={boards} what="your boards">
              No boards yet. A board holds sticky notes, boxes, arrows and cards for your tasks,
              notes and people.
            </NoRows>
          }
        >
          <ul>
            <For each={list()}>
              {(r, i) => (
                <li
                  class="group flex cursor-pointer items-center gap-3 border-b border-line py-1 pr-2 pl-4 md:py-2.5"
                  data-active={focused() && i() === sel.index()}
                  onClick={(e) => {
                    sel.select(i());
                    open(r, e.shiftKey);
                  }}
                >
                  <span class="min-w-0 flex-1 truncate font-medium">{r.title || "Untitled"}</span>
                  <span class="shrink-0 text-xs text-faint">{ago(r.updatedAt)}</span>
                  <Overflow
                    class={ROW_MENU}
                    label={`Actions for ${r.title || "Untitled"}`}
                    items={[
                      { label: "Move to trash", danger: true, run: () => void moveToTrash(r.id) },
                    ]}
                  />
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </div>
  );
}

export function CanvasView(props: { id: string; pane: number }) {
  return (
    <ForRecord record={{ id: props.id, type: "canvas" }}>
      <Board id={props.id} pane={props.pane} />
    </ForRecord>
  );
}
