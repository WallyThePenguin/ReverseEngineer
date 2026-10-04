// Canvas boards (PLAN.md section 8.6): a list, and a board per pane.

import { createSignal, For, lazy, Show } from "solid-js";
import { Button, Empty, PaneHeader } from "../components/ui.tsx";
import { ago } from "../lib/format.ts";
import { listKeys, useHotkeys } from "../lib/hotkeys.ts";
import { layout } from "../lib/panes.ts";
import { act, useAction } from "../lib/query.ts";

// The board is only needed once one opens.
const Board = lazy(() => import("../canvas/Board.tsx").then((m) => ({ default: m.CanvasBoard })));

type Row = { id: string; title: string; updatedAt: string };

export async function newCanvas(pane: number) {
  const made = await act<{ id: string }>("canvas.create", { title: "Untitled board" });
  if (made) layout.open({ view: "canvas", id: made.id }, { pane });
}

export function Canvases(props: { pane: number }) {
  const boards = useAction<Row[]>("canvas.list", () => ({ limit: 100 }));
  const [index, setIndex] = createSignal(0);
  const list = () => boards.data ?? [];
  const focused = () => layout.focused() === props.pane;
  const open = (r: Row | undefined, beside = false) => {
    if (!r) return;
    if (beside) layout.open({ view: "canvas", id: r.id }, { beside: true });
    else layout.show({ view: "canvas", id: r.id }, props.pane);
  };

  useHotkeys([
    ...listKeys({ count: () => list().length, index, setIndex, when: focused }),
    { keys: "enter", run: () => open(list()[index()]), when: focused, label: "Open board" },
    { keys: "c", run: () => void newCanvas(props.pane), when: focused, label: "New board" },
  ]);

  return (
    <div class="flex h-full flex-col">
      <PaneHeader title="Canvas">
        <Button kind="primary" small onClick={() => void newCanvas(props.pane)}>
          New board
        </Button>
      </PaneHeader>
      <div class="flex-1 overflow-auto">
        <Show
          when={list().length > 0}
          fallback={
            <Empty>
              {boards.isLoading
                ? "Loading…"
                : "No boards yet. A board holds sticky notes, boxes, arrows and cards for your tasks, notes and people."}
            </Empty>
          }
        >
          <ul>
            <For each={list()}>
              {(r, i) => (
                <li
                  class="flex cursor-pointer items-baseline gap-3 border-b border-line px-4 py-2.5"
                  data-active={focused() && i() === index()}
                  onClick={(e) => {
                    setIndex(i());
                    open(r, e.shiftKey);
                  }}
                >
                  <span class="min-w-0 flex-1 truncate font-medium">{r.title || "Untitled"}</span>
                  <span class="shrink-0 text-xs text-faint">{ago(r.updatedAt)}</span>
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
  return <Board id={props.id} pane={props.pane} />;
}
