import { describe, expect, it } from "vitest";
import {
  cellName,
  columnName,
  columnNumber,
  parseCell,
  renameSheetRefs,
  sheetRef,
  type Workbook,
  WorkbookSchema,
} from "./sheet.ts";

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

describe("renaming a sheet", () => {
  const book: Workbook = {
    sheets: [
      { id: "a", name: "Costs", cells: { B3: "1500" }, widths: {} },
      {
        id: "b",
        name: "Plan",
        cells: {
          A1: "=Costs!B3*12",
          A2: "=SUM('Costs'!B1:B3) + costs!B3",
          A3: '="Costs!B3 is the total"',
          A4: "=MyCosts!B3",
          A5: "Costs!B3",
        },
        widths: {},
      },
    ],
  };

  it("rewrites every formula that points at it, and nothing else", () => {
    const out = renameSheetRefs(book, 0, "Monthly costs");
    expect(out.sheets[0]!.name).toBe("Monthly costs");
    expect(out.sheets[1]!.cells).toEqual({
      A1: "='Monthly costs'!B3*12",
      A2: "=SUM('Monthly costs'!B1:B3) + 'Monthly costs'!B3",
      A3: '="Costs!B3 is the total"',
      A4: "=MyCosts!B3",
      A5: "Costs!B3",
    });
    expect(renameSheetRefs(book, 0, "Spend").sheets[1]!.cells.A1).toBe("=Spend!B3*12");
    expect(book.sheets[0]!.name).toBe("Costs");
  });

  it("quotes a name that couldn't stand bare", () => {
    expect([sheetRef("Q4"), sheetRef("AB12"), sheetRef("Q4 plan"), sheetRef("Budget_2")]).toEqual([
      "'Q4'",
      "'AB12'",
      "'Q4 plan'",
      "Budget_2",
    ]);
  });
});
