import { describe, expect, it } from "vitest";
import { clampPos, fromTsv, isNumber, rangeOf, refsIn, toTsv } from "./grid.ts";

describe("grid", () => {
  it("copies a range as tab-separated rows and pastes it back from another cell", () => {
    const r = rangeOf({ row: 2, col: 2 }, { row: 1, col: 1 });
    expect(refsIn(r)).toEqual(["A1", "B1", "A2", "B2"]);
    const vals: Record<string, string> = { A1: "x", B1: "=A1", A2: "multi\nline" };
    const tsv = toTsv(r, (ref) => vals[ref] ?? "");
    expect(tsv).toBe("x\t=A1\nmulti line\t");
    expect(fromTsv(`${tsv}\r\n`, { row: 5, col: 3 })).toEqual({
      C5: "x",
      D5: "=A1",
      C6: "multi line",
      D6: "",
    });
    expect(Object.keys(fromTsv("a\tb", { row: 500, col: 52 }))).toEqual(["AZ500"]);
  });

  it("keeps the cursor on the sheet and spots numbers", () => {
    expect(clampPos({ row: 0, col: 99 })).toEqual({ row: 1, col: 52 });
    for (const n of ["12", "-1.5", "$1,200", "15%", "1e3"]) expect(isNumber(n)).toBe(true);
    for (const s of ["", "abc", "#DIV/0!", "12 apples"]) expect(isNumber(s)).toBe(false);
  });
});
