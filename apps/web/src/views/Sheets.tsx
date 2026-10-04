// Spreadsheets (PLAN.md section 8.5): a list, and a spreadsheet per pane.

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

// The grid (and its formula engine) is only needed once one opens.
const Grid = lazy(() => import("../sheets/Grid.tsx").then((m) => ({ default: m.SheetGrid })));

type Row = { id: string; title: string; updatedAt: string };

export async function newSheet(pane: number) {
  const made = await act<{ id: string }>("sheet.create", { title: "Untitled spreadsheet" });
  if (made) layout.open({ view: "sheet", id: made.id }, { pane });
}

export function Sheets(props: { pane: number }) {
  const sheets = useAction<Row[]>("sheet.list", () => ({ limit: 100 }));
  const list = () => sheets.data ?? [];
  const sel = createSelection(list, (r) => r.id);
  const focused = () => layout.focused() === props.pane;
  const open = (r: Row | undefined, beside = false) => {
    if (!r) return;
    if (beside) layout.open({ view: "sheet", id: r.id }, { beside: true });
    else layout.show({ view: "sheet", id: r.id }, props.pane);
  };

  useHotkeys([
    ...listKeys({
      count: () => list().length,
      index: sel.index,
      setIndex: sel.select,
      when: focused,
    }),
    { keys: "enter", run: () => open(sel.current()), when: focused, label: "Open spreadsheet" },
    trashKey(sel.current, focused),
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
            <NoRows query={sheets} what="your spreadsheets">
              No spreadsheets yet. A spreadsheet works out Excel-style formulas, and Jarvis can read
              and fill it in.
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

export function SheetView(props: { id: string; pane: number }) {
  return (
    <ForRecord record={{ id: props.id, type: "spreadsheet" }}>
      <Grid id={props.id} pane={props.pane} />
    </ForRecord>
  );
}
