// A spreadsheet (PLAN.md section 8.5): a grid of cells with a formula bar and sheet tabs. Type to
// fill a cell, = for a formula; arrows, Tab and Enter move; Ctrl+C and Ctrl+V copy and paste with
// Excel and Google Sheets.

import { cellName, columnName, parseCell } from "@hearth/core";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { PaneHeader } from "../components/ui.tsx";
import { useAction } from "../lib/query.ts";
import { clampPos, fromTsv, inRange, isNumber, type Pos, rangeOf, refsIn, toTsv } from "./grid.ts";
import { createSheet } from "./state.ts";
import { Tabs } from "./Tabs.tsx";

const WIDTH = 96;

export function SheetGrid(props: { id: string; pane: number }) {
  const s = createSheet(props.id);
  const [tab, setTab] = createSignal(0);
  const [cur, setCur] = createSignal<Pos>({ row: 1, col: 1 });
  const [anchor, setAnchor] = createSignal<Pos>({ row: 1, col: 1 });
  const [editing, setEditing] = createSignal<"cell" | "bar" | null>(null);
  const [draft, setDraft] = createSignal("");
  let keys: HTMLInputElement | undefined;
  let scroller!: HTMLDivElement;

  // Another screen or Jarvis saved it: take it in (the sheet keeps unsaved edits).
  const remote = useAction<{ version: number }>("sheet.get", () => ({ id: props.id }));
  createEffect(
    on(
      () => remote.data?.version,
      () => void s.load(),
      { defer: true },
    ),
  );
  onMount(() => void s.load());
  onCleanup(() => void s.flush());

  const sheet = () => s.book.sheets[Math.min(tab(), s.book.sheets.length - 1)]!;
  const raw = (ref: string) => sheet().cells[ref] ?? "";
  const shown = (ref: string) => s.results()[tab()]?.[ref] ?? raw(ref);
  const range = () => rangeOf(anchor(), cur());
  const width = (col: number) => sheet().widths[columnName(col)] ?? WIDTH;

  // Show what's used, plus room to grow into.
  const used = createMemo(() => {
    let rows = 0;
    let cols = 0;
    for (const ref of Object.keys(sheet().cells)) {
      const at = parseCell(ref);
      if (at) {
        rows = Math.max(rows, at.row);
        cols = Math.max(cols, at.col);
      }
    }
    return { rows, cols };
  });
  const rows = () => Math.min(500, Math.max(50, used().rows + 20, cur().row + 10));
  const cols = () => Math.min(52, Math.max(12, used().cols + 4, cur().col + 3));
  const rowList = createMemo(() => Array.from({ length: rows() }, (_, i) => i + 1));
  const colList = createMemo(() => Array.from({ length: cols() }, (_, i) => i + 1));

  const focusGrid = () => queueMicrotask(() => keys?.focus({ preventScroll: true }));
  createEffect(on(cur, () => editing() !== "bar" && focusGrid()));
  createEffect(
    on(cur, (p) => {
      const el = scroller?.querySelector<HTMLElement>(`[data-cell="${cellName(p.row, p.col)}"]`);
      el?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }),
  );

  const move = (dr: number, dc: number, extend = false) => {
    const next = clampPos({ row: cur().row + dr, col: cur().col + dc });
    setCur(next);
    if (!extend) setAnchor(next);
  };
  const select = (p: Pos, extend = false) => {
    setCur(p);
    if (!extend) setAnchor(p);
  };
  const startEdit = (from: "cell" | "bar", text = raw(cellName(cur().row, cur().col))) => {
    setDraft(text);
    setEditing(from);
  };
  const commit = () => {
    if (!editing()) return;
    s.set(tab(), { [cellName(cur().row, cur().col)]: draft() });
    setEditing(null);
  };
  const cancel = () => {
    setEditing(null);
    focusGrid();
  };

  function onKey(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    if (editing()) {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
        move(e.shiftKey ? -1 : 1, 0);
      } else if (e.key === "Tab") {
        e.preventDefault();
        commit();
        move(0, e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
      return;
    }
    const steps: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      PageUp: [-20, 0],
      PageDown: [20, 0],
    };
    const step = steps[e.key];
    if (step) {
      e.preventDefault();
      const far = mod ? 500 : 1;
      move(step[0] * far, step[1] * far, e.shiftKey);
    } else if (e.key === "Tab" || e.key === "Enter") {
      e.preventDefault();
      if (e.key === "Tab") move(0, e.shiftKey ? -1 : 1);
      else move(e.shiftKey ? -1 : 1, 0);
    } else if (e.key === "F2") {
      e.preventDefault();
      startEdit("cell");
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      s.set(tab(), Object.fromEntries(refsIn(range()).map((r) => [r, ""])));
    } else if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) s.redo();
      else s.undo();
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      s.redo();
    } else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setAnchor({ row: 1, col: 1 });
      setCur({ row: used().rows || 1, col: used().cols || 1 });
    }
  }

  const clipboard = (e: ClipboardEvent, cut = false) => {
    if (editing()) return;
    e.preventDefault();
    e.clipboardData?.setData("text/plain", toTsv(range(), raw));
    if (cut) s.set(tab(), Object.fromEntries(refsIn(range()).map((r) => [r, ""])));
  };
  const paste = (e: ClipboardEvent) => {
    if (editing()) return;
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    const r = range();
    if (text) s.set(tab(), fromTsv(text, { row: r.top, col: r.left }));
  };

  // Dragging a column header's right edge sets its width.
  const resize = (col: number, e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const start = e.clientX;
    const from = width(col);
    let to = from;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const th = el.parentElement!;
    const moveIt = (m: PointerEvent) => {
      to = Math.min(800, Math.max(30, from + m.clientX - start));
      th.style.width = `${to}px`;
      th.style.minWidth = `${to}px`;
    };
    const up = () => {
      el.removeEventListener("pointermove", moveIt);
      el.removeEventListener("pointerup", up);
      if (to !== from)
        s.change((d) => {
          d.sheets[tab()]!.widths[columnName(col)] = Math.round(to);
        });
    };
    el.addEventListener("pointermove", moveIt);
    el.addEventListener("pointerup", up);
  };

  const curRef = () => cellName(cur().row, cur().col);

  return (
    <div class="flex h-full flex-col">
      <PaneHeader
        title={
          <input
            class="w-full bg-transparent outline-none"
            aria-label="Spreadsheet name"
            value={s.title()}
            placeholder="Untitled spreadsheet"
            onChange={(e) => void s.rename(e.currentTarget.value.trim() || "Untitled spreadsheet")}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        }
        sub={
          s.problem() ??
          (s.saving() ? "Saving…" : "Type to fill a cell · = starts a formula · F2 edits")
        }
      />
      <div class="flex items-center gap-2 border-b border-line px-2 py-1 text-sm">
        <span class="w-14 shrink-0 text-center font-mono text-xs text-muted">{curRef()}</span>
        <span class="text-faint">ƒx</span>
        <input
          class="min-w-0 flex-1 rounded bg-sunk px-2 py-1 font-mono text-xs outline-none"
          aria-label="Cell contents"
          value={editing() ? draft() : raw(curRef())}
          onFocus={() => editing() !== "bar" && startEdit("bar", editing() ? draft() : undefined)}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={onKey}
          onBlur={() => editing() === "bar" && commit()}
        />
      </div>
      <div ref={scroller} class="relative flex-1 overflow-auto" data-sheet-grid>
        <Show when={s.loaded()} fallback={<p class="p-4 text-sm text-muted">Loading…</p>}>
          <table
            class="border-separate border-spacing-0 text-sm"
            style={{ "table-layout": "fixed" }}
          >
            <thead>
              <tr>
                <th class="sticky top-0 left-0 z-20 w-10 min-w-10 border-r border-b border-line bg-sunk" />
                <For each={colList()}>
                  {(c) => (
                    <th
                      class="sticky top-0 z-10 border-r border-b border-line bg-sunk px-1 text-xs font-normal text-muted"
                      classList={{ "text-ink": c >= range().left && c <= range().right }}
                      style={{ width: `${width(c)}px`, "min-width": `${width(c)}px` }}
                    >
                      <div class="relative">
                        {columnName(c)}
                        <div
                          class="absolute -right-1 top-0 h-full w-2 cursor-col-resize"
                          onPointerDown={(e) => resize(c, e)}
                        />
                      </div>
                    </th>
                  )}
                </For>
              </tr>
            </thead>
            <tbody>
              <For each={rowList()}>
                {(r) => (
                  <tr>
                    <th class="sticky left-0 z-10 border-r border-b border-line bg-sunk px-1 text-right text-xs font-normal text-muted">
                      {r}
                    </th>
                    <For each={colList()}>
                      {(c) => {
                        const ref = cellName(r, c);
                        const here = () => cur().row === r && cur().col === c;
                        const value = () => shown(ref);
                        return (
                          <td
                            data-cell={ref}
                            class="relative h-6 max-w-0 truncate border-r border-b border-line px-1"
                            classList={{
                              "bg-jarvis/10": inRange(range(), r, c) && !here(),
                              "text-right": isNumber(value()),
                              "outline outline-2 -outline-offset-2 outline-jarvis": here(),
                            }}
                            onMouseDown={(e) => {
                              if (e.button !== 0) return;
                              e.preventDefault();
                              if (editing()) commit();
                              select({ row: r, col: c }, e.shiftKey);
                              focusGrid();
                            }}
                            onMouseEnter={(e) =>
                              e.buttons === 1 && select({ row: r, col: c }, true)
                            }
                            onDblClick={() => {
                              startEdit("cell");
                              focusGrid();
                            }}
                          >
                            {here() && editing() === "cell" ? "" : value()}
                            <Show when={here()}>
                              <input
                                ref={keys}
                                class="absolute inset-0 h-full w-full bg-panel px-1 outline-none"
                                classList={{
                                  "pointer-events-none opacity-0": editing() !== "cell",
                                }}
                                aria-label={`Cell ${ref}`}
                                value={editing() === "cell" ? draft() : ""}
                                onInput={(e) => {
                                  // Read it first: starting the edit re-renders the input's value.
                                  const text = e.currentTarget.value;
                                  setDraft(text);
                                  setEditing("cell");
                                }}
                                onKeyDown={onKey}
                                onCopy={(e) => clipboard(e)}
                                onCut={(e) => clipboard(e, true)}
                                onPaste={paste}
                                onBlur={() => editing() === "cell" && commit()}
                              />
                            </Show>
                          </td>
                        );
                      }}
                    </For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </div>
      <Tabs
        sheet={s}
        tab={tab()}
        onTab={(i) => {
          setTab(i);
          select({ row: 1, col: 1 });
        }}
      />
    </div>
  );
}
