// A spreadsheet's sheet tabs: pick one, double-click to rename, + to add, × to remove.

import { WorksheetSchema } from "@hearth/core";
import { For, Show } from "solid-js";
import type { Sheet } from "./state.ts";

export function Tabs(props: { sheet: Sheet; tab: number; onTab: (i: number) => void }) {
  const names = () => props.sheet.book.sheets.map((x) => x.name.toLowerCase());
  const valid = (name: string, except = -1) =>
    WorksheetSchema.shape.name.safeParse(name).success &&
    !names().some((n, i) => i !== except && n === name.toLowerCase());

  const add = () => {
    let n = props.sheet.book.sheets.length + 1;
    while (names().includes(`sheet${n}`)) n += 1;
    props.sheet.change((d) => {
      d.sheets.push({
        id: crypto.randomUUID().slice(0, 8),
        name: `Sheet${n}`,
        cells: {},
        widths: {},
      });
    });
    props.onTab(props.sheet.book.sheets.length - 1);
  };
  const rename = (i: number) => {
    const now = props.sheet.book.sheets[i]!.name;
    const name = window.prompt("Sheet name", now)?.trim();
    if (!name || name === now) return;
    if (!valid(name, i)) {
      window.alert("That name is taken, or uses [ ] : * ? / \\ or '.");
      return;
    }
    props.sheet.renameSheet(i, name);
  };
  const remove = (i: number) => {
    const s = props.sheet.book.sheets[i]!;
    if (Object.keys(s.cells).length && !window.confirm(`Delete ${s.name} and everything on it?`))
      return;
    props.sheet.change((d) => {
      d.sheets.splice(i, 1);
    });
    props.onTab(Math.max(0, Math.min(props.tab, props.sheet.book.sheets.length - 1)));
  };

  return (
    <div class="flex items-center gap-1 overflow-x-auto border-t border-line bg-sunk px-2 py-1 text-sm">
      <For each={props.sheet.book.sheets}>
        {(s, i) => (
          <span
            class="group flex shrink-0 items-center rounded"
            classList={{ "bg-panel shadow-sm": i() === props.tab }}
          >
            <button
              type="button"
              class="px-2 py-0.5"
              classList={{ "font-medium": i() === props.tab, "text-muted": i() !== props.tab }}
              title="Double-click to rename"
              onClick={() => props.onTab(i())}
              onDblClick={() => rename(i())}
            >
              {s.name}
            </button>
            <Show when={props.sheet.book.sheets.length > 1 && i() === props.tab}>
              <button
                type="button"
                class="pr-1.5 text-faint hover:text-ink"
                title={`Delete ${s.name}`}
                onClick={() => remove(i())}
              >
                ×
              </button>
            </Show>
          </span>
        )}
      </For>
      <Show when={props.sheet.book.sheets.length < 20}>
        <button
          type="button"
          class="px-2 text-muted hover:text-ink"
          title="Add a sheet"
          onClick={add}
        >
          +
        </button>
      </Show>
    </div>
  );
}
