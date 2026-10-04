import type { Canvas } from "@hearth/core";
import { describe, expect, it } from "vitest";
import { edgePath, facing, fit, nodeAt, toBoard, zoomAt } from "./geometry.ts";

const board: Canvas = {
  nodes: [
    { id: "a", type: "text", text: "A", x: 0, y: 0, width: 100, height: 50 },
    { id: "b", type: "text", text: "B", x: 300, y: 0, width: 100, height: 50 },
  ],
  edges: [
    {
      id: "e",
      from: { type: "connected", node: "a", side: "right" },
      to: { type: "connected", node: "b", side: "left" },
    },
  ],
};

describe("canvas geometry", () => {
  it("joins cards side to side", () => {
    const p = edgePath(board, board.edges[0]!)!;
    expect(p.d.startsWith("M 100 25")).toBe(true);
    expect(p.head).toEqual({ x: 300, y: 25 });
    expect(facing(board.nodes[0]!, { x: 500, y: 30 })).toBe("right");
    expect(facing(board.nodes[0]!, { x: 50, y: -200 })).toBe("top");
  });

  it("finds cards and keeps the point under the cursor when zooming", () => {
    expect(nodeAt(board, { x: 320, y: 10 })?.id).toBe("b");
    expect(nodeAt(board, { x: 200, y: 10 })).toBeUndefined();
    const cam = zoomAt({ x: 0, y: 0, zoom: 1 }, { x: 100, y: 100 }, 2);
    expect(toBoard(cam, { x: 100, y: 100 })).toEqual({ x: 100, y: 100 });
    const f = fit(board, { width: 800, height: 600 });
    expect(f.zoom).toBeGreaterThan(1);
  });
});
