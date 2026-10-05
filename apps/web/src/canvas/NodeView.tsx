// One card on the board: text, a shape, a record (@link) or a web link.

import type { CanvasNode } from "@hearth/core";
import { Match, Show, Switch } from "solid-js";
import { TYPE_LABEL } from "../lib/format.ts";

/** Text on a colored card stays dark, whatever the theme. */
const ink = (fill?: string) => (fill && fill !== "transparent" ? "#1f1b16" : undefined);

const host = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

export function NodeView(props: {
  node: CanvasNode;
  selected: boolean;
  editing: boolean;
  onText: (text: string) => void;
}) {
  const n = () => props.node;
  const fill = () => n().style?.fillColor;
  const text = () => ("text" in n() ? (n() as { text: string }).text : "");
  const box = () => ({
    left: `${n().x}px`,
    top: `${n().y}px`,
    width: `${n().width}px`,
    height: `${n().height}px`,
    background: fill(),
    color: ink(fill()),
    "font-size": n().style?.textSize ? `${n().style!.textSize}px` : undefined,
  });
  const ring = () => (props.selected ? "outline outline-2 outline-accent" : "");

  const editor = () => (
    <textarea
      class="h-full w-full resize-none bg-transparent p-2 outline-none"
      style={{ color: "inherit", "text-align": n().type === "shape" ? "center" : undefined }}
      value={text()}
      ref={(el) => queueMicrotask(() => el.focus())}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={(e) => props.onText(e.currentTarget.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") e.currentTarget.blur();
      }}
    />
  );

  return (
    <div
      data-node={n().id}
      class={`absolute overflow-hidden ${ring()}`}
      classList={{
        "rounded-md border border-line bg-panel shadow-sm": n().type !== "shape",
        "rounded-md border-2 border-ink/60":
          n().type === "shape" &&
          "shape" in n() &&
          (n() as { shape: string }).shape === "rectangle",
        "rounded-[50%] border-2 border-ink/60":
          n().type === "shape" && "shape" in n() && (n() as { shape: string }).shape === "ellipse",
      }}
      style={box()}
    >
      <Switch>
        <Match when={props.editing}>{editor()}</Match>
        <Match when={n().type === "text"}>
          <p class="h-full overflow-hidden p-2 whitespace-pre-wrap">{text()}</p>
        </Match>
        <Match when={n().type === "shape"}>
          <p class="flex h-full items-center justify-center p-2 text-center whitespace-pre-wrap">
            {text()}
          </p>
        </Match>
        <Match when={n().type === "entitymention" && n()}>
          {(m) => {
            const r = m() as Extract<CanvasNode, { type: "entitymention" }>;
            return (
              <div class="flex h-full flex-col justify-center gap-0.5 px-3 py-2">
                <span class="text-micro uppercase tracking-wide text-faint">
                  {TYPE_LABEL[r.entityType] ?? r.entityType}
                </span>
                <span class="truncate font-medium text-accent">{r.label || "Untitled"}</span>
              </div>
            );
          }}
        </Match>
        <Match when={n().type === "link" && n()}>
          {(m) => {
            const url = (m() as Extract<CanvasNode, { type: "link" }>).url;
            return (
              <div class="flex h-full flex-col justify-center px-3 py-2">
                <span class="truncate font-medium">{host(url)}</span>
                <span class="truncate text-xs text-muted">{url}</span>
              </div>
            );
          }}
        </Match>
      </Switch>
      <Show when={props.selected && !props.editing}>
        <div
          data-handle={n().id}
          class="absolute right-0 bottom-0 size-3 cursor-nwse-resize rounded-tl bg-accent"
        />
      </Show>
    </div>
  );
}
