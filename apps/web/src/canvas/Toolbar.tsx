// The board's tools, colors, record picker and zoom.

import type { CanvasNode } from "@hearth/core";
import { createSignal, For, Show } from "solid-js";
import { action } from "../lib/api.ts";
import type { SearchHit } from "../lib/types.ts";
import type { Board, Tool } from "./state.ts";

const TOOLS: { tool: Tool; label: string; key: string }[] = [
  { tool: "select", label: "Select", key: "V" },
  { tool: "text", label: "Text", key: "T" },
  { tool: "rectangle", label: "Box", key: "R" },
  { tool: "ellipse", label: "Circle", key: "O" },
  { tool: "arrow", label: "Arrow", key: "A" },
];

const FILLS = ["#fff7ed", "#fef3c7", "#dcfce7", "#dbeafe", "#f3e8ff", "#fee2e2", "transparent"];

const btn = (on: boolean) =>
  `rounded px-2 py-1 text-xs ${on ? "bg-accent text-white" : "text-muted hover:bg-sunk hover:text-ink"}`;

export function Toolbar(props: {
  board: Board;
  zoom: number;
  onZoom: (factor: number) => void;
  onFit: () => void;
  /** Puts a record's card in the middle of the view. */
  onRecord: (hit: SearchHit) => void;
}) {
  const b = props.board;
  const [picking, setPicking] = createSignal(false);
  const [hits, setHits] = createSignal<SearchHit[]>([]);
  const search = async (q: string) => {
    setHits(
      await (q.trim()
        ? action<SearchHit[]>("entity.search", { query: q, limit: 8 })
        : action<SearchHit[]>("entity.recent", { limit: 8 })
      ).catch(() => []),
    );
  };
  const paint = (fill: string) =>
    b.change((d) => {
      for (const n of d.nodes as CanvasNode[])
        if (b.selected().has(n.id)) n.style = { ...n.style, fillColor: fill };
    });

  return (
    <div
      data-toolbar
      class="absolute top-3 left-3 z-10 flex flex-wrap items-center gap-1 rounded-lg border border-line bg-panel p-1 shadow-md"
    >
      <For each={TOOLS}>
        {(t) => (
          <button
            type="button"
            class={btn(b.tool() === t.tool)}
            title={`${t.label} (${t.key})`}
            onClick={() => b.setTool(t.tool)}
          >
            {t.label}
          </button>
        )}
      </For>
      <span class="mx-1 h-4 w-px bg-line" />
      <div class="relative">
        <button
          type="button"
          class={btn(picking())}
          title="Put a task, note, person or any record on the board"
          onClick={() => {
            setPicking(!picking());
            void search("");
          }}
        >
          @ Record
        </button>
        <Show when={picking()}>
          <div class="absolute top-8 left-0 w-64 rounded-md border border-line bg-panel p-2 shadow-lg">
            <input
              class="mb-1 w-full rounded border border-line bg-panel px-2 py-1 text-sm outline-none"
              placeholder="Find a record…"
              aria-label="Find a record"
              ref={(el) => queueMicrotask(() => el.focus())}
              onInput={(e) => void search(e.currentTarget.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") setPicking(false);
              }}
            />
            <ul class="max-h-60 overflow-auto">
              <For each={hits()}>
                {(h) => (
                  <li>
                    <button
                      type="button"
                      class="w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-sunk"
                      onClick={() => {
                        props.onRecord(h);
                        setPicking(false);
                      }}
                    >
                      {h.title || "Untitled"} <span class="text-xs text-faint">{h.type}</span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>
      </div>
      <Show when={b.selected().size > 0}>
        <span class="mx-1 h-4 w-px bg-line" />
        <For each={FILLS}>
          {(f) => (
            <button
              type="button"
              aria-label={f === "transparent" ? "No fill" : `Fill ${f}`}
              class="size-5 rounded-full border border-line"
              style={{
                background:
                  f === "transparent"
                    ? "linear-gradient(135deg, transparent 45%, var(--color-bad) 45% 55%, transparent 55%)"
                    : f,
              }}
              onClick={() => paint(f)}
            />
          )}
        </For>
      </Show>
      <span class="mx-1 h-4 w-px bg-line" />
      <button type="button" class={btn(false)} title="Undo (Ctrl+Z)" onClick={() => b.undo()}>
        Undo
      </button>
      <button type="button" class={btn(false)} title="Zoom out" onClick={() => props.onZoom(0.8)}>
        −
      </button>
      <button type="button" class={btn(false)} title="Fit everything" onClick={props.onFit}>
        {Math.round(props.zoom * 100)}%
      </button>
      <button type="button" class={btn(false)} title="Zoom in" onClick={() => props.onZoom(1.25)}>
        +
      </button>
    </div>
  );
}
