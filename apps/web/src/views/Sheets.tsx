// Spreadsheets (PLAN.md section 8.5): a list, and a spreadsheet per pane.

import { createSignal, For, lazy, Show } from "solid-js";
import { Button, Empty, PaneHeader } from "../components/ui.tsx";
import { ago } from "../lib/format.ts";
import { listKeys, useHotkeys } from "../lib/hotkeys.ts";
import { layout } from "../lib/panes.ts";
import { act, useAction } from "../lib/query.ts";

// The grid (and its formula engine) is only needed once one opens.
const Grid = lazy(() => import("../sheets/Grid.tsx").then((m) => ({ default: m.SheetGrid })));

type Row = { id: string; title: string; updatedAt: string };

export async function newSheet(pane: number) {
  const made = await act<{ id: string }>("sheet.create", { title: "Untitled spreadsheet" });
  if (made) layout.open({ view: "sheet", id: made.id }, { pane });
}

export function Sheets(props: { pane: number }) {
  const sheets = useAction<Row[]>("sheet.list", () => ({ limit: 100 }));
  const [index, setIndex] = createSignal(0);
  const list = () => sheets.data ?? [];
  const focused = () => layout.focused() === props.pane;
  const open = (r: Row | undefined, beside = false) => {
    if (!r) return;
    if (beside) layout.open({ view: "sheet", id: r.id }, { beside: true });
    else layout.show({ view: "sheet", id: r.id }, props.pane);
  };

  useHotkeys([
    ...listKeys({ count: () => list().length, index, setIndex, when: focused }),
    { keys: "enter", run: () => open(list()[index()]), when: focused, label: "Open spreadsheet" },
    { keys: "c", run: () => void newSheet(props.pane), when: focused, label: "New spreadsheet" },
  ]);

  return (
    <div class="flex h-full flex-col">
      <PaneHeader title="Spreadsheets">
        <Button kind="primary" small onClick={() => void newSheet(props.pane)}>
          New spreadsheet
        </Button>
      </PaneHeader>
      <div class="flex-1 overflow-auto">
        <Show
          when={list().length > 0}
          fallback={
            <Empty>
              {sheets.isLoading
                ? "Loading…"
                : "No spreadsheets yet. A spreadsheet works out Excel-style formulas, and Jarvis can read and fill it in."}
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

export function SheetView(props: { id: string; pane: number }) {
  return <Grid id={props.id} pane={props.pane} />;
}
