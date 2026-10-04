import { describe, expect, it } from "vitest";
import type { Canvas } from "./canvas.ts";
import { mergeCanvas, mergeRecord, mergeText, mergeWorkbook } from "./merge.ts";
import type { Workbook } from "./sheet.ts";

const card = (id: string, text: string, y = 0) =>
  ({ id, type: "text", text, x: 0, y, width: 200, height: 80 }) as const;
const arrow = (id: string, from: string, to: string): Canvas["edges"][number] => ({
  id,
  from: { type: "connected", node: from, side: "right" },
  to: { type: "connected", node: to, side: "left" },
});

describe("merging a board", () => {
  const base: Canvas = { nodes: [card("a", "Goals"), card("b", "Risks")], edges: [] };

  it("keeps Jarvis's new cards and the edit made at the same time", () => {
    const theirs: Canvas = { ...base, nodes: [...base.nodes, card("j", "From Jarvis", 200)] };
    const mine: Canvas = { ...base, nodes: [card("a", "Goals for Q4"), base.nodes[1]!] };
    const out = mergeCanvas(base, mine, theirs);
    expect(out.nodes.map((n) => (n.type === "text" ? n.text : ""))).toEqual([
      "Goals for Q4",
      "Risks",
      "From Jarvis",
    ]);
  });

  it("deletes only what the other side left alone, and drops arrows to deleted cards", () => {
    const mine: Canvas = {
      nodes: [card("a", "Goals"), card("c", "New here")],
      edges: [arrow("e1", "a", "c")],
    };
    const theirs: Canvas = { nodes: [card("b", "Risks, edited")], edges: [] };
    const out = mergeCanvas(base, mine, theirs);
    // a: they deleted it, I left it alone → gone. b: I deleted it, they changed it → kept.
    expect(out.nodes.map((n) => n.id)).toEqual(["b", "c"]);
    expect(out.edges).toEqual([]);
  });

  it("prefers this screen's change when both sides changed the same card", () => {
    const mine: Canvas = { ...base, nodes: [card("a", "Mine"), base.nodes[1]!] };
    const theirs: Canvas = { ...base, nodes: [card("a", "Theirs"), base.nodes[1]!] };
    expect(mergeCanvas(base, mine, theirs).nodes[0]).toMatchObject({ text: "Mine" });
  });

  it("reads a card the same whatever order its fields came in", () => {
    const shuffled = { height: 80, width: 200, y: 0, x: 0, text: "Goals", type: "text", id: "a" };
    const mine = { ...base, nodes: [shuffled as Canvas["nodes"][number], base.nodes[1]!] };
    const theirs: Canvas = { ...base, nodes: [card("a", "Theirs"), base.nodes[1]!] };
    expect(mergeCanvas(base, mine, theirs).nodes[0]).toMatchObject({ text: "Theirs" });
  });
});

describe("merging a workbook", () => {
  const sheet = (id: string, name: string, cells: Record<string, string>) => ({
    id,
    name,
    cells,
    widths: {},
  });
  const base: Workbook = { sheets: [sheet("s1", "Costs", { A1: "Rent", B1: "1200" })] };

  it("merges cell by cell", () => {
    const mine: Workbook = { sheets: [sheet("s1", "Costs", { A1: "Rent", B1: "1300" })] };
    const theirs: Workbook = {
      sheets: [sheet("s1", "Costs", { A1: "Rent", B1: "1200", A2: "Food", B2: "300" })],
    };
    expect(mergeWorkbook(base, mine, theirs).sheets[0]!.cells).toEqual({
      A1: "Rent",
      B1: "1300",
      A2: "Food",
      B2: "300",
    });
  });

  it("keeps sheets added on both sides, renaming a clash", () => {
    const mine: Workbook = { sheets: [...base.sheets, sheet("m", "Plan", { A1: "1" })] };
    const theirs: Workbook = { sheets: [...base.sheets, sheet("t", "Plan", { A1: "2" })] };
    const out = mergeWorkbook(base, mine, theirs);
    expect(out.sheets.map((s) => s.name)).toEqual(["Costs", "Plan", "Plan (2)"]);
    expect(theirs.sheets[1]!.name).toBe("Plan");
  });

  it("keeps a renamed sheet's new name and the other side's cells", () => {
    const mine: Workbook = { sheets: [sheet("s1", "Spending", base.sheets[0]!.cells)] };
    const theirs: Workbook = { sheets: [sheet("s1", "Costs", { A1: "Rent", B1: "1250" })] };
    const out = mergeWorkbook(base, mine, theirs).sheets[0]!;
    expect([out.name, out.cells.B1]).toEqual(["Spending", "1250"]);
  });

  it("clears a cell only the screen cleared", () => {
    expect(mergeRecord({ A1: "x", B1: "y" }, { B1: "y" }, { A1: "x", B1: "z" })).toEqual({
      B1: "z",
    });
    expect(mergeRecord({ A1: "x" }, {}, { A1: "changed" })).toEqual({ A1: "changed" });
  });
});

describe("merging text", () => {
  it("takes whichever side changed, and keeps both sides' new lines when both did", () => {
    expect(mergeText("a", "a b", "a")).toBe("a b");
    expect(mergeText("a", "a", "a c")).toBe("a c");
    expect(mergeText("intro\n", "intro\nmine\n", "intro\ntheirs\n")).toBe("intro\nmine\ntheirs");
    expect(mergeText("x", "y", "y")).toBe("y");
  });
});
