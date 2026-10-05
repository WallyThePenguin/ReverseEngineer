import { describe, expect, it } from "vitest";
import { blocks, inline } from "./markdown.ts";

describe("inline markdown", () => {
  it("reads links, bold, italics, code and bare links", () => {
    expect(inline("See [the plan](https://example.com/a_b) and **now**, *soon* or `x_y`.")).toEqual(
      [
        { kind: "text", text: "See " },
        { kind: "link", text: "the plan", href: "https://example.com/a_b" },
        { kind: "text", text: " and " },
        { kind: "strong", text: "now" },
        { kind: "text", text: ", " },
        { kind: "em", text: "soon" },
        { kind: "text", text: " or " },
        { kind: "code", text: "x_y" },
        { kind: "text", text: "." },
      ],
    );
    expect(inline("Go to https://example.com/x.")).toEqual([
      { kind: "text", text: "Go to " },
      { kind: "link", text: "https://example.com/x", href: "https://example.com/x" },
      { kind: "text", text: "." },
    ]);
  });

  it("leaves snake_case, lone stars and unsafe links as text", () => {
    expect(inline("file_name_here and 2 * 3 * 4")).toEqual([
      { kind: "text", text: "file_name_here and 2 * 3 * 4" },
    ]);
    expect(inline("[click](javascript:alert(1))")).toEqual([
      { kind: "text", text: "[click](javascript:alert(1))" },
    ]);
  });
});

describe("block markdown", () => {
  it("reads headings, lists, numbered steps, quotes, rules and checklists", () => {
    expect(
      blocks("## Plan\n1. Call\n2) Book\n- one\n  - two\n> said\n---\n- [x] done\nplain"),
    ).toEqual([
      { kind: "heading", level: 2, text: "Plan" },
      { kind: "number", n: 1, text: "Call", depth: 0 },
      { kind: "number", n: 2, text: "Book", depth: 0 },
      { kind: "bullet", text: "one", depth: 0 },
      { kind: "bullet", text: "two", depth: 1 },
      { kind: "quote", text: "said" },
      { kind: "rule" },
      { kind: "check", text: "done", done: true, line: 7 },
      { kind: "line", text: "plain" },
    ]);
  });

  it("keeps code fences whole and reads tables", () => {
    expect(
      blocks("```ts\nconst a = 1;\n# not a heading\n```\n| A | B |\n|---|:-:|\n| 1 | 2 |\nend"),
    ).toEqual([
      { kind: "code", text: "const a = 1;\n# not a heading" },
      { kind: "table", head: ["A", "B"], rows: [["1", "2"]] },
      { kind: "line", text: "end" },
    ]);
  });

  it("keeps a checklist item's line number past a code fence", () => {
    const b = blocks("```\nx\n```\n- [ ] after");
    expect(b.at(-1)).toEqual({ kind: "check", text: "after", done: false, line: 3 });
  });
});
