import { describe, expect, it } from "vitest";
import { lineMarks } from "./mdmarks.ts";

describe("lineMarks", () => {
  it("marks headings, quotes and list markers", () => {
    expect(lineMarks("# Plan")).toEqual({ line: "cm-md-h1", marks: [[0, 1, "cm-md-marker"]] });
    expect(lineMarks("### Notes").line).toBe("cm-md-h3");
    expect(lineMarks("> said").line).toBe("cm-md-quote");
    expect(lineMarks("  - item").marks).toEqual([[2, 3, "cm-md-marker"]]);
    expect(lineMarks("12. step").marks).toEqual([[0, 3, "cm-md-marker"]]);
    expect(lineMarks("#hashtag")).toEqual({ marks: [] });
  });

  it("marks bold, italic, code and strike in order", () => {
    expect(lineMarks("a **b** _c_ `d` ~~e~~").marks).toEqual([
      [2, 7, "cm-md-strong"],
      [8, 11, "cm-md-em"],
      [12, 15, "cm-md-code"],
      [16, 21, "cm-md-strike"],
    ]);
    // A list star and bold stars aren't italics; nor are underscores inside words.
    expect(lineMarks("* **x**").marks).toEqual([
      [0, 1, "cm-md-marker"],
      [2, 7, "cm-md-strong"],
    ]);
    expect(lineMarks("snake_case_name").marks).toEqual([]);
  });

  it("leaves mentions alone", () => {
    const chip = '<m-ref type="memory_note" id="x">a *b* c</m-ref>';
    expect(lineMarks(`see ${chip} and *this*`).marks).toEqual([
      [chip.length + 9, chip.length + 15, "cm-md-em"],
    ]);
  });
});
