import { describe, expect, it } from "vitest";
import { CanvasSchema, canvasMarkdown } from "./canvas.ts";
import { parseMentions } from "./mentions.ts";

const TASK = "0b9d8f3e-1c2a-4e5f-9a7b-123456789abc";

describe("canvas boards", () => {
  it("reads as markdown, top to bottom, with record cards as @links", () => {
    const c = CanvasSchema.parse({
      nodes: [
        { id: "b", type: "text", text: "Ship <it>", x: 0, y: 200, width: 100, height: 40 },
        {
          id: "a",
          type: "shape",
          shape: "ellipse",
          text: "Plan",
          x: 0,
          y: 0,
          width: 80,
          height: 80,
        },
        {
          id: "t",
          type: "entitymention",
          file: TASK,
          entityType: "task",
          label: "Pay rent",
          x: 300,
          y: 0,
          width: 200,
          height: 60,
        },
      ],
      edges: [
        {
          id: "e",
          from: { type: "connected", node: "a", side: "right" },
          to: { type: "connected", node: "t", side: "left" },
          label: "first",
        },
      ],
    });
    const md = canvasMarkdown(c);
    expect(md.split("\n\n").slice(0, 3)).toEqual([
      "[Plan]",
      `<m-ref type="task" id="${TASK}">Pay rent</m-ref>`,
      "Ship &lt;it&gt;",
    ]);
    expect(md).toContain("- Plan → Pay rent (first)");
    expect(parseMentions(md)).toMatchObject([{ type: "task", id: TASK }]);
  });

  it("refuses boards it can't draw", () => {
    expect(
      CanvasSchema.safeParse({ nodes: [{ id: "x", type: "video", x: 0, y: 0 }] }).success,
    ).toBe(false);
    const link = (url: string) =>
      CanvasSchema.safeParse({
        nodes: [{ id: "l", type: "link", url, x: 0, y: 0, width: 100, height: 40 }],
      }).success;
    expect(link("https://example.com/a")).toBe(true);
    expect(link("javascript:alert(1)")).toBe(false);
    expect(link("file:///C:/Windows/notepad.exe")).toBe(false);
  });
});
