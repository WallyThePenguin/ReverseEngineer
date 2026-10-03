import { describe, expect, it } from "vitest";
import { cellName, columnName, columnNumber, parseCell, WorkbookSchema } from "./sheet.ts";

describe("spreadsheet cells", () => {
  it("names columns like a spreadsheet", () => {
    expect([1, 26, 27, 52].map(columnName)).toEqual(["A", "Z", "AA", "AZ"]);
    expect(columnNumber("AZ")).toBe(52);
    expect(parseCell("b3")).toEqual({ row: 3, col: 2 });
    expect(parseCell("BA1")).toBeNull();
    expect(parseCell("A501")).toBeNull();
    expect(cellName(10, 27)).toBe("AA10");
  });

  it("refuses cells off the sheet and sheets with the same name", () => {
    const sheet = (name: string, cells = {}) => ({ id: name, name, cells });
    expect(WorkbookSchema.safeParse({ sheets: [sheet("A", { ZZ9: "1" })] }).success).toBe(false);
    expect(WorkbookSchema.safeParse({ sheets: [sheet("A"), sheet("a")] }).success).toBe(false);
    expect(WorkbookSchema.safeParse({ sheets: [sheet("Budget", { A1: "=1+1" })] }).success).toBe(
      true,
    );
  });
});
