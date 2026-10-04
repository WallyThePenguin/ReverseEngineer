// The board's geometry: where an arrow leaves a card, the path it takes, and what's under a point.
// The side and curve rules follow Macro's block-canvas connectors (AGPL-3.0), much simplified.

import type { Canvas, CanvasEdge, CanvasEdgeEnd, CanvasNode, Side } from "@hearth/core";

export interface Point {
  x: number;
  y: number;
}

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export function anchor(n: CanvasNode, side: Side): Point {
  switch (side) {
    case "top":
      return { x: n.x + n.width / 2, y: n.y };
    case "bottom":
      return { x: n.x + n.width / 2, y: n.y + n.height };
    case "left":
      return { x: n.x, y: n.y + n.height / 2 };
    default:
      return { x: n.x + n.width, y: n.y + n.height / 2 };
  }
}

const center = (n: CanvasNode): Point => ({ x: n.x + n.width / 2, y: n.y + n.height / 2 });

/** The side of `n` that faces `p`. */
export function facing(n: CanvasNode, p: Point): Side {
  const c = center(n);
  const dx = (p.x - c.x) / Math.max(n.width, 1);
  const dy = (p.y - c.y) / Math.max(n.height, 1);
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "bottom" : "top";
}

const OUT: Record<Side, Point> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

function endPoint(c: Canvas, e: CanvasEdgeEnd): { p: Point; dir: Point | null } | null {
  if (e.type === "free") return { p: { x: e.x, y: e.y }, dir: null };
  const n = c.nodes.find((x) => x.id === e.node);
  return n ? { p: anchor(n, e.side), dir: OUT[e.side] } : null;
}

/** An arrow's SVG path: a smooth curve out of each card's side, and where it points at the end. */
export function edgePath(
  c: Canvas,
  e: CanvasEdge,
): { d: string; head: Point; angle: number } | null {
  const a = endPoint(c, e.from);
  const b = endPoint(c, e.to);
  if (!a || !b) return null;
  const reach = Math.max(40, Math.hypot(b.p.x - a.p.x, b.p.y - a.p.y) / 3);
  const c1 = a.dir ? { x: a.p.x + a.dir.x * reach, y: a.p.y + a.dir.y * reach } : a.p;
  const c2 = b.dir ? { x: b.p.x + b.dir.x * reach, y: b.p.y + b.dir.y * reach } : b.p;
  const angle = Math.atan2(b.p.y - c2.y || b.p.y - a.p.y, b.p.x - c2.x || b.p.x - a.p.x);
  return {
    d: `M ${a.p.x} ${a.p.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.p.x} ${b.p.y}`,
    head: b.p,
    angle,
  };
}

/** The top card under a board point, if any. */
export function nodeAt(c: Canvas, p: Point): CanvasNode | undefined {
  for (let i = c.nodes.length - 1; i >= 0; i--) {
    const n = c.nodes[i]!;
    if (p.x >= n.x && p.x <= n.x + n.width && p.y >= n.y && p.y <= n.y + n.height) return n;
  }
  return undefined;
}

/** Screen point to board point. */
export const toBoard = (cam: Camera, p: Point): Point => ({
  x: (p.x - cam.x) / cam.zoom,
  y: (p.y - cam.y) / cam.zoom,
});

/** Zooms about a screen point, so what's under the cursor stays there. */
export function zoomAt(cam: Camera, p: Point, zoom: number): Camera {
  const z = Math.min(4, Math.max(0.1, zoom));
  const at = toBoard(cam, p);
  return { zoom: z, x: p.x - at.x * z, y: p.y - at.y * z };
}

/** A camera that shows every card, with some room around them. */
export function fit(c: Canvas, view: { width: number; height: number }): Camera {
  if (!c.nodes.length) return { x: view.width / 2 - 200, y: 80, zoom: 1 };
  const minX = Math.min(...c.nodes.map((n) => n.x));
  const minY = Math.min(...c.nodes.map((n) => n.y));
  const maxX = Math.max(...c.nodes.map((n) => n.x + n.width));
  const maxY = Math.max(...c.nodes.map((n) => n.y + n.height));
  const zoom = Math.min(
    1.5,
    Math.max(0.1, Math.min(view.width / (maxX - minX + 160), view.height / (maxY - minY + 160))),
  );
  return {
    zoom,
    x: view.width / 2 - ((minX + maxX) / 2) * zoom,
    y: view.height / 2 - ((minY + maxY) / 2) * zoom,
  };
}
