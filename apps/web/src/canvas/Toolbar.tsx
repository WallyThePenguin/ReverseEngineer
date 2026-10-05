// The board's tools, colors, record picker and zoom.

import type { CanvasNode } from "@hearth/core";
import { createSignal, For, Show } from "solid-js";
import { Icon, type IconName } from "../components/icons.tsx";
import { action } from "../lib/api.ts";
import type { SearchHit } from "../lib/types.ts";
import type { Board, Tool } from "./state.ts";

/** Each tool is an icon; its name is its tooltip, with its key. */
const TOOLS: { tool: Tool; label: string; key: string; icon: IconName }[] = [
  { tool: "select", label: "Select", key: "V", icon: "mouse-pointer-2" },
  { tool: "text", label: "Text", key: "T", icon: "type" },
  { tool: "rectangle", label: "Box", key: "R", icon: "square" },
  { tool: "ellipse", label: "Circle", key: "O", icon: "circle" },
  { tool: "arrow", label: "Arrow", key: "A", icon: "move-up-right" },
];

const FILLS = ["#fff7ed", "#fef3c7", "#dcfce7", "#dbeafe", "#f3e8ff", "#fee2e2", "transparent"];

const btn = (on: boolean) =>
  `flex h-7 min-w-7 items-center justify-center gap-1 rounded px-1.5 text-xs ${on ? "bg-accent text-on-fill" : "text-muted hover:bg-sunk hover:text-ink"}`;

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
            aria-label={t.label}
            aria-pressed={b.tool() === t.tool}
            onClick={() => b.setTool(t.tool)}
          >
            <Icon name={t.icon} />
          </button>
        )}
      </For>
      <span class="mx-1 h-4 w-px bg-line" />
      <div class="relative">
        <button
          type="button"
          class={btn(picking())}
          title="Put a task, note, person or any record on the board"
          aria-label="@ Record"
          aria-expanded={picking()}
          onClick={() => {
            setPicking(!picking());
            void search("");
          }}
        >
          <Icon name="at-sign" />
          Record
        </button>
        <Show when={picking()}>
          <div class="absolute top-9 left-0 w-64 rounded-md border border-line bg-panel p-2 shadow-lg">
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
      <button
        type="button"
        class={btn(false)}
        title="Undo (Ctrl+Z)"
        aria-label="Undo"
        onClick={() => b.undo()}
      >
        <Icon name="undo-2" />
      </button>
      <button
        type="button"
        class={btn(false)}
        title="Zoom out"
        aria-label="Zoom out"
        onClick={() => props.onZoom(0.8)}
      >
        <Icon name="minus" />
      </button>
      <button type="button" class={btn(false)} title="Fit everything" onClick={props.onFit}>
        {Math.round(props.zoom * 100)}%
      </button>
      <button
        type="button"
        class={btn(false)}
        title="Zoom in"
        aria-label="Zoom in"
        onClick={() => props.onZoom(1.25)}
      >
        <Icon name="plus" />
      </button>
    </div>
  );
}
