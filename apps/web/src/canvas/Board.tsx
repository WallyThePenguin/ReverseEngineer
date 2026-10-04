// A canvas board (PLAN.md section 8.6): drag the background to pan, Ctrl+wheel or pinch to zoom,
// double-click to write. Cards for records open beside the board.

import type { CanvasEdgeEnd, CanvasNode } from "@hearth/core";
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { PaneHeader } from "../components/ui.tsx";
import { useHotkeys } from "../lib/hotkeys.ts";
import { layout, routeFor } from "../lib/panes.ts";
import { useAction } from "../lib/query.ts";
import type { SearchHit } from "../lib/types.ts";
import {
  type Camera,
  edgePath,
  facing,
  fit,
  nodeAt,
  type Point,
  toBoard,
  zoomAt,
} from "./geometry.ts";
import { NodeView } from "./NodeView.tsx";
import { createBoard, newId } from "./state.ts";
import { Toolbar } from "./Toolbar.tsx";

type Drag =
  | { kind: "pan"; from: Point; cam: Camera }
  | { kind: "move"; from: Point; started: boolean; origin: Map<string, Point> }
  | { kind: "resize"; id: string; from: Point; started: boolean; size: Point }
  | { kind: "arrow"; from: CanvasEdgeEnd; start: Point };

const SIZE = { text: [220, 100], rectangle: [180, 100], ellipse: [140, 140] } as const;

export function CanvasBoard(props: { id: string; pane: number }) {
  const b = createBoard(props.id);
  const [cam, setCam] = createSignal<Camera>({ x: 0, y: 0, zoom: 1 });
  const [editing, setEditing] = createSignal<string | null>(null);
  const [arrow, setArrow] = createSignal<{ from: CanvasEdgeEnd; to: Point } | null>(null);
  let el!: HTMLDivElement;
  let drag: Drag | null = null;
  const touches = new Map<number, Point>();
  let pinch: { dist: number; zoom: number } | null = null;

  // Another screen or Jarvis saved it: take it in (the board keeps unsaved edits).
  const remote = useAction<{ version: number }>("canvas.get", () => ({ id: props.id }));
  createEffect(
    on(
      () => remote.data?.version,
      () => void b.load(),
      { defer: true },
    ),
  );
  onMount(async () => {
    await b.load();
    setCam(fit(b.board, el.getBoundingClientRect()));
    el.addEventListener("wheel", wheel, { passive: false });
  });
  onCleanup(() => {
    el?.removeEventListener("wheel", wheel);
    void b.flush();
  });

  const screen = (e: { clientX: number; clientY: number }): Point => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const point = (e: { clientX: number; clientY: number }) => toBoard(cam(), screen(e));
  const nodeOf = (id: string) => b.board.nodes.find((n) => n.id === id);

  function wheel(e: WheelEvent) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) setCam(zoomAt(cam(), screen(e), cam().zoom * (1 - e.deltaY / 300)));
    else setCam({ ...cam(), x: cam().x - e.deltaX, y: cam().y - e.deltaY });
  }

  const place = (tool: "text" | "rectangle" | "ellipse", p: Point) => {
    const [w, h] = SIZE[tool];
    const base = { id: newId(), x: p.x - w / 2, y: p.y - h / 2, width: w, height: h };
    const node: CanvasNode =
      tool === "text"
        ? { ...base, type: "text", text: "" }
        : { ...base, type: "shape", shape: tool, text: "" };
    b.add(node);
    b.setTool("select");
    setEditing(node.id);
  };

  const addRecord = (hit: SearchHit) => {
    const r = el.getBoundingClientRect();
    const c = toBoard(cam(), { x: r.width / 2, y: r.height / 2 });
    b.add({
      id: newId(),
      type: "entitymention",
      file: hit.id,
      entityType: hit.type,
      label: hit.title || "Untitled",
      x: c.x - 110,
      y: c.y - 36,
      width: 220,
      height: 72,
    });
  };

  const down = (e: PointerEvent) => {
    // The toolbar's own buttons and inputs.
    if ((e.target as HTMLElement).closest("[data-toolbar]")) return;
    // Finish any typing first, and keep the browser from moving focus off a card being placed.
    e.preventDefault();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    touches.set(e.pointerId, screen(e));
    el.setPointerCapture(e.pointerId);
    if (touches.size === 2) {
      const [a, c] = [...touches.values()] as [Point, Point];
      pinch = { dist: Math.hypot(a.x - c.x, a.y - c.y), zoom: cam().zoom };
      drag = null;
      return;
    }
    const target = e.target as HTMLElement;
    const handle = target.closest<HTMLElement>("[data-handle]")?.dataset.handle;
    const nodeId = target.closest<HTMLElement>("[data-node]")?.dataset.node;
    const edgeId = target.closest<SVGElement>("[data-edge]")?.dataset.edge;
    const p = point(e);
    const tool = b.tool();
    if (tool === "text" || tool === "rectangle" || tool === "ellipse") return place(tool, p);
    if (tool === "arrow") {
      const n = nodeId ? nodeOf(nodeId) : undefined;
      const from: CanvasEdgeEnd = n
        ? { type: "connected", node: n.id, side: facing(n, p) }
        : { type: "free", x: p.x, y: p.y };
      drag = { kind: "arrow", from, start: p };
      setArrow({ from, to: p });
      return;
    }
    if (handle) {
      const n = nodeOf(handle)!;
      drag = {
        kind: "resize",
        id: n.id,
        from: p,
        started: false,
        size: { x: n.width, y: n.height },
      };
    } else if (nodeId) {
      if (!b.selected().has(nodeId)) b.select([nodeId], e.shiftKey);
      const origin = new Map<string, Point>();
      for (const n of b.board.nodes)
        if (b.selected().has(n.id)) origin.set(n.id, { x: n.x, y: n.y });
      drag = { kind: "move", from: p, started: false, origin };
    } else if (edgeId) {
      b.select([edgeId], e.shiftKey);
    } else {
      setEditing(null);
      b.select([]);
      drag = { kind: "pan", from: screen(e), cam: cam() };
    }
  };

  const move = (e: PointerEvent) => {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, screen(e));
    if (pinch && touches.size === 2) {
      const [a, c] = [...touches.values()] as [Point, Point];
      const mid = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 };
      setCam(zoomAt(cam(), mid, (pinch.zoom * Math.hypot(a.x - c.x, a.y - c.y)) / pinch.dist));
      return;
    }
    if (!drag) return;
    const p = point(e);
    if (drag.kind === "pan") {
      const s = screen(e);
      setCam({ ...drag.cam, x: drag.cam.x + s.x - drag.from.x, y: drag.cam.y + s.y - drag.from.y });
    } else if (drag.kind === "move") {
      const d = drag;
      if (!d.started) b.begin();
      d.started = true;
      b.preview((board) => {
        for (const n of board.nodes) {
          const o = d.origin.get(n.id);
          if (o) Object.assign(n, { x: o.x + p.x - d.from.x, y: o.y + p.y - d.from.y });
        }
      });
    } else if (drag.kind === "resize") {
      const d = drag;
      if (!d.started) b.begin();
      d.started = true;
      b.preview((board) => {
        const n = board.nodes.find((x) => x.id === d.id);
        if (n) {
          n.width = Math.max(40, d.size.x + p.x - d.from.x);
          n.height = Math.max(30, d.size.y + p.y - d.from.y);
        }
      });
    } else setArrow({ from: drag.from, to: p });
  };

  const up = (e: PointerEvent) => {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
    const d = drag;
    drag = null;
    if (!d) return;
    if ((d.kind === "move" || d.kind === "resize") && d.started) b.commit();
    if (d.kind !== "arrow") return;
    setArrow(null);
    b.setTool("select");
    const p = point(e);
    if (Math.hypot(p.x - d.start.x, p.y - d.start.y) < 10) return;
    // Each end leaves from the side that faces the other end.
    const mid = (x: CanvasNode) => ({ x: x.x + x.width / 2, y: x.y + x.height / 2 });
    const src = d.from.type === "connected" ? nodeOf(d.from.node) : undefined;
    const n = nodeAt(b.board, p);
    const dst = n && n.id !== src?.id ? n : undefined;
    const to: CanvasEdgeEnd = dst
      ? { type: "connected", node: dst.id, side: facing(dst, src ? mid(src) : d.start) }
      : { type: "free", x: p.x, y: p.y };
    const from: CanvasEdgeEnd = src
      ? { type: "connected", node: src.id, side: facing(src, dst ? mid(dst) : p) }
      : d.from;
    b.connect({ id: newId(), from, to });
  };

  const dblclick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-toolbar]")) return;
    const nodeId = (e.target as HTMLElement).closest<HTMLElement>("[data-node]")?.dataset.node;
    const n = nodeId ? nodeOf(nodeId) : undefined;
    if (!n) return place("text", point(e));
    if (n.type === "entitymention")
      layout.open(routeFor(n.entityType, n.file), { pane: props.pane, beside: true });
    else if (n.type === "link") {
      if (/^https?:\/\//i.test(n.url)) window.open(n.url, "_blank", "noopener");
    } else setEditing(n.id);
  };

  const here = () => layout.focused() === props.pane;
  const tool = (t: Parameters<typeof b.setTool>[0]) => () => b.setTool(t);
  useHotkeys([
    { keys: "mod+z", run: () => b.undo(), when: here, label: "Undo on the board" },
    { keys: "mod+shift+z", run: () => b.redo(), when: here, label: "Redo on the board" },
    { keys: "delete", run: () => b.remove(b.selected()), when: here },
    { keys: "backspace", run: () => b.remove(b.selected()), when: here },
    {
      keys: "escape",
      run: () => {
        b.select([]);
        b.setTool("select");
      },
      when: here,
    },
    { keys: "v", run: tool("select"), when: here, label: "Board: select" },
    { keys: "t", run: tool("text"), when: here, label: "Board: text" },
    { keys: "r", run: tool("rectangle"), when: here, label: "Board: box" },
    { keys: "o", run: tool("ellipse"), when: here, label: "Board: circle" },
    { keys: "a", run: tool("arrow"), when: here, label: "Board: arrow" },
  ]);

  const setText = (id: string, text: string) => {
    setEditing(null);
    const n = nodeOf(id);
    if (!n || !("text" in n) || n.text === text) {
      // A text card left empty is dropped.
      if (n?.type === "text" && !text.trim()) b.remove(new Set([id]));
      return;
    }
    b.change((d) => {
      const m = d.nodes.find((x) => x.id === id);
      if (m && "text" in m) m.text = text;
    });
  };

  const grid = () => `${24 * cam().zoom}px ${24 * cam().zoom}px`;

  return (
    <div class="flex h-full flex-col">
      <PaneHeader
        title={
          <input
            class="w-full bg-transparent outline-none"
            aria-label="Board name"
            value={b.title()}
            placeholder="Untitled board"
            onChange={(e) => void b.rename(e.currentTarget.value.trim() || "Untitled board")}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        }
        sub="Double-click to write · drag the background to move around · Ctrl+scroll to zoom"
      />
      <div
        ref={el}
        class="relative min-h-0 flex-1 touch-none overflow-hidden outline-none select-none"
        classList={{ "cursor-crosshair": b.tool() !== "select" }}
        style={{
          "background-image": "radial-gradient(var(--color-line) 1px, transparent 1px)",
          "background-size": grid(),
          "background-position": `${cam().x}px ${cam().y}px`,
        }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onDblClick={dblclick}
      >
        <div
          class="absolute top-0 left-0"
          style={{
            transform: `translate(${cam().x}px, ${cam().y}px) scale(${cam().zoom})`,
            "transform-origin": "0 0",
          }}
        >
          <svg
            class="absolute top-0 left-0 overflow-visible"
            width="1"
            height="1"
            aria-hidden="true"
          >
            <For each={b.board.edges}>
              {(edge) => {
                const path = () => edgePath(b.board, edge);
                const on = () => b.selected().has(edge.id);
                return (
                  <Show when={path()}>
                    {(p) => (
                      <g data-edge={edge.id}>
                        <path d={p().d} stroke="transparent" stroke-width="14" fill="none" />
                        <path
                          d={p().d}
                          fill="none"
                          stroke={on() ? "var(--color-accent)" : "var(--color-muted)"}
                          stroke-width="2"
                        />
                        <polygon
                          points="0,0 -12,-6 -12,6"
                          fill={on() ? "var(--color-accent)" : "var(--color-muted)"}
                          transform={`translate(${p().head.x} ${p().head.y}) rotate(${(p().angle * 180) / Math.PI})`}
                        />
                      </g>
                    )}
                  </Show>
                );
              }}
            </For>
            <Show when={arrow()}>
              {(a) => {
                const p = () =>
                  edgePath(b.board, {
                    id: "draft",
                    from: a().from,
                    to: { type: "free", x: a().to.x, y: a().to.y },
                  });
                return (
                  <path
                    d={p()?.d ?? ""}
                    fill="none"
                    stroke="var(--color-accent)"
                    stroke-width="2"
                    stroke-dasharray="6 4"
                  />
                );
              }}
            </Show>
          </svg>
          <For each={b.board.nodes}>
            {(n) => (
              <NodeView
                node={n}
                selected={b.selected().has(n.id)}
                editing={editing() === n.id}
                onText={(t) => setText(n.id, t)}
              />
            )}
          </For>
        </div>
        <Toolbar
          board={b}
          zoom={cam().zoom}
          onZoom={(f) => {
            const r = el.getBoundingClientRect();
            setCam(zoomAt(cam(), { x: r.width / 2, y: r.height / 2 }, cam().zoom * f));
          }}
          onFit={() => setCam(fit(b.board, el.getBoundingClientRect()))}
          onRecord={addRecord}
        />
        <Show when={b.loaded() && b.board.nodes.length === 0}>
          <p class="pointer-events-none absolute inset-x-0 top-1/2 text-center text-sm text-muted">
            Double-click anywhere to write, or pick a tool above.
          </p>
        </Show>
      </div>
    </div>
  );
}
