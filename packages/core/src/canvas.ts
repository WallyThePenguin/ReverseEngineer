// A canvas board: cards, shapes and arrows on a 2D plane. The shape of the data follows Macro's
// block-canvas model (CanvasModel.ts, AGPL-3.0), trimmed to what Hearth draws: text cards,
// cards for records (@links), web links and shapes, joined by arrows (D47).
import { z } from "zod";
import { escapeText, renderMention } from "./mentions.ts";

const SIDES = ["top", "right", "bottom", "left"] as const;
export type Side = (typeof SIDES)[number];

const color = z.union([z.literal("transparent"), z.string().regex(/^#[0-9a-f]{3,8}$/i)]);

export const CanvasStyleSchema = z.object({
  fillColor: color.optional(),
  strokeColor: color.optional(),
  textSize: z.number().min(8).max(96).optional(),
});

const base = {
  id: z.string().min(1).max(64),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().min(8).max(20_000),
  height: z.number().finite().min(8).max(20_000),
  style: CanvasStyleSchema.optional(),
};

export const CanvasNodeSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("text"), text: z.string().max(20_000) }),
  z.object({
    ...base,
    type: z.literal("entitymention"),
    /** The record's id (Macro calls it `file`). */
    file: z.string().uuid(),
    entityType: z.string().min(1).max(40),
    label: z.string().max(500),
  }),
  z.object({
    ...base,
    type: z.literal("link"),
    // Web pages only: a javascript: or file: link would run or open something when clicked.
    url: z
      .string()
      .url()
      .max(2000)
      .refine((u) => /^https?:\/\//i.test(u), "must be an http(s) link"),
  }),
  z.object({
    ...base,
    type: z.literal("shape"),
    shape: z.enum(["rectangle", "ellipse"]),
    text: z.string().max(5000).default(""),
  }),
]);

const end = z.union([
  z.object({ type: z.literal("connected"), node: z.string().min(1).max(64), side: z.enum(SIDES) }),
  z.object({ type: z.literal("free"), x: z.number().finite(), y: z.number().finite() }),
]);

export const CanvasEdgeSchema = z.object({
  id: z.string().min(1).max(64),
  from: end,
  to: end,
  label: z.string().max(500).optional(),
  style: CanvasStyleSchema.optional(),
});

export const CanvasSchema = z.object({
  nodes: z.array(CanvasNodeSchema).max(2000).default([]),
  edges: z.array(CanvasEdgeSchema).max(4000).default([]),
});

export type CanvasNode = z.infer<typeof CanvasNodeSchema>;
export type CanvasEdge = z.infer<typeof CanvasEdgeSchema>;
export type CanvasEdgeEnd = CanvasEdge["from"];
export type Canvas = z.infer<typeof CanvasSchema>;

/**
 * The board as markdown, top to bottom and left to right: the text on it, and its record cards
 * as @links. It's the board's body, so search, backlinks and Jarvis read the board like a note.
 */
export function canvasMarkdown(c: Canvas): string {
  const label = (id: string) => {
    const n = c.nodes.find((x) => x.id === id);
    if (!n) return "?";
    if (n.type === "entitymention") return n.label;
    if (n.type === "link") return n.url;
    return n.text.split("\n")[0]?.slice(0, 60) || n.type;
  };
  const sorted = [...c.nodes].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = sorted.map((n) => {
    switch (n.type) {
      case "text":
        return escapeText(n.text);
      case "shape":
        return n.text ? `[${escapeText(n.text)}]` : "";
      case "link":
        return n.url;
      default:
        return renderMention({ type: n.entityType, id: n.file, label: n.label });
    }
  });
  const arrows = c.edges
    .filter((e) => e.from.type === "connected" && e.to.type === "connected")
    .map((e) => {
      const from = e.from.type === "connected" ? label(e.from.node) : "";
      const to = e.to.type === "connected" ? label(e.to.node) : "";
      return `- ${escapeText(from)} → ${escapeText(to)}${e.label ? ` (${escapeText(e.label)})` : ""}`;
    });
  return [...lines.filter(Boolean), ...(arrows.length ? ["", "Arrows:", ...arrows] : [])].join(
    "\n\n",
  );
}
