// A spreadsheet (PLAN.md section 8.5's "spreadsheets"): sheets of cells, each cell what you typed
// (a value or a =formula). Results are worked out by IronCalc, in the browser and on the server,
// and never stored as the source.
import { z } from "zod";

export const SHEET_ROWS = 500;
export const SHEET_COLUMNS = 52;
const MAX_SHEETS = 20;
const MAX_CELL = 2000;

/** "A1" … "AZ500". */
export const CELL_REF = /^([A-Z]{1,2})([1-9][0-9]{0,3})$/;

export function columnName(col: number): string {
  // 1 → A, 26 → Z, 27 → AA.
  let n = col;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function columnNumber(name: string): number {
  let n = 0;
  for (const c of name) n = n * 26 + (c.charCodeAt(0) - 64);
  return n;
}

/** "B3" → { row: 3, col: 2 }, or null when it isn't a cell on a sheet. */
export function parseCell(ref: string): { row: number; col: number } | null {
  const m = CELL_REF.exec(ref.trim().toUpperCase());
  if (!m) return null;
  const col = columnNumber(m[1]!);
  const row = Number(m[2]);
  if (col > SHEET_COLUMNS || row > SHEET_ROWS) return null;
  return { row, col };
}

export const cellName = (row: number, col: number) => `${columnName(col)}${row}`;

const cellKey = z.string().refine((k) => parseCell(k) !== null, "not a cell like A1");

export const WorksheetSchema = z.object({
  id: z.string().min(1).max(40),
  name: z
    .string()
    .trim()
    .min(1)
    .max(31)
    // biome-ignore lint/complexity/noUselessEscapeInRegex: the model API's regex engine reads a bare "[" in a class as a nested class and rejects every Jarvis turn.
    .regex(/^[^\[\]:*?/\\']+$/, "sheet names can't use [ ] : * ? / \\ or '"),
  cells: z.record(cellKey, z.string().max(MAX_CELL)).default({}),
  /** Column widths in pixels, by column letter. */
  widths: z.record(z.string().regex(/^[A-Z]{1,2}$/), z.number().min(30).max(800)).default({}),
});

export const WorkbookSchema = z
  .object({ sheets: z.array(WorksheetSchema).min(1).max(MAX_SHEETS) })
  .refine((b) => new Set(b.sheets.map((s) => s.name.toLowerCase())).size === b.sheets.length, {
    message: "two sheets have the same name",
  });

export type Worksheet = z.infer<typeof WorksheetSchema>;
export type Workbook = z.infer<typeof WorkbookSchema>;

export const emptyWorkbook = (): Workbook => ({
  sheets: [{ id: "s1", name: "Sheet1", cells: {}, widths: {} }],
});

/** The part of IronCalc's Model that working out a workbook needs. */
export interface CalcModel {
  newSheet(): void;
  renameSheet(sheet: number, name: string): void;
  setUserInput(sheet: number, row: number, column: number, input: string): void;
  evaluate(): void;
  getFormattedCellValue(sheet: number, row: number, column: number): string;
  free(): void;
}

/** Each sheet's results, by cell, for the cells that hold something. */
export type Results = Record<string, string>[];

/** Works out every formula in the workbook. `model` makes an empty IronCalc model. */
export function calculate(book: Workbook, model: () => CalcModel): Results {
  const m = model();
  try {
    book.sheets.forEach((s, i) => {
      if (i > 0) m.newSheet();
      m.renameSheet(i, s.name);
    });
    book.sheets.forEach((s, i) => {
      for (const [ref, input] of Object.entries(s.cells)) {
        const at = parseCell(ref);
        if (at && input !== "") m.setUserInput(i, at.row, at.col, input);
      }
    });
    m.evaluate();
    return book.sheets.map((s, i) => {
      const out: Record<string, string> = {};
      for (const ref of Object.keys(s.cells)) {
        const at = parseCell(ref);
        if (at) out[ref] = m.getFormattedCellValue(i, at.row, at.col);
      }
      return out;
    });
  } finally {
    m.free();
  }
}

/** The workbook as markdown tables of results, for search, backlinks and Jarvis. */
export function workbookMarkdown(book: Workbook, results: Results, maxRows = 60, maxCols = 15) {
  const parts: string[] = [];
  book.sheets.forEach((s, i) => {
    const refs = Object.keys(s.cells)
      .map(parseCell)
      .filter((x): x is { row: number; col: number } => x !== null);
    if (!refs.length) return;
    const rows = Math.min(maxRows, Math.max(...refs.map((r) => r.row)));
    const cols = Math.min(maxCols, Math.max(...refs.map((r) => r.col)));
    const cell = (v = "") =>
      v
        .replace(/<(\/?m-ref)/gi, "‹$1")
        .replace(/\|/g, "\\|")
        .replace(/\s*\n\s*/g, " ");
    const lines = [
      `## ${s.name}`,
      "",
      `| | ${Array.from({ length: cols }, (_, c) => columnName(c + 1)).join(" | ")} |`,
      `|---|${Array.from({ length: cols }, () => "---").join("|")}|`,
    ];
    for (let r = 1; r <= rows; r++) {
      const row = Array.from({ length: cols }, (_, c) => cell(results[i]?.[cellName(r, c + 1)]));
      if (row.some(Boolean)) lines.push(`| ${r} | ${row.join(" | ")} |`);
    }
    parts.push(lines.join("\n"));
  });
  return parts.join("\n\n");
}
