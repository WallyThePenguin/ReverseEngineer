// Grid helpers: positions, ranges, and copying and pasting as tab-separated text (what Excel and
// Google Sheets put on the clipboard).
import { cellName, SHEET_COLUMNS, SHEET_ROWS } from "@hearth/core";

export type Pos = { row: number; col: number };
export type Range = { top: number; left: number; bottom: number; right: number };

export const clampPos = (p: Pos): Pos => ({
  row: Math.min(SHEET_ROWS, Math.max(1, p.row)),
  col: Math.min(SHEET_COLUMNS, Math.max(1, p.col)),
});

export const rangeOf = (a: Pos, b: Pos): Range => ({
  top: Math.min(a.row, b.row),
  left: Math.min(a.col, b.col),
  bottom: Math.max(a.row, b.row),
  right: Math.max(a.col, b.col),
});

export const inRange = (r: Range, row: number, col: number) =>
  row >= r.top && row <= r.bottom && col >= r.left && col <= r.right;

export function refsIn(r: Range): string[] {
  const out: string[] = [];
  for (let row = r.top; row <= r.bottom; row++)
    for (let col = r.left; col <= r.right; col++) out.push(cellName(row, col));
  return out;
}

/** The range as tab-separated rows, each cell as `value` picks (what you typed, or its result). */
export function toTsv(r: Range, value: (ref: string) => string): string {
  const lines: string[] = [];
  for (let row = r.top; row <= r.bottom; row++) {
    const cells: string[] = [];
    for (let col = r.left; col <= r.right; col++)
      cells.push(value(cellName(row, col)).replace(/[\t\n\r]+/g, " "));
    lines.push(cells.join("\t"));
  }
  return lines.join("\n");
}

/** Pasted text placed from `at`, as cell → input. Cells off the sheet are dropped. */
export function fromTsv(text: string, at: Pos): Record<string, string> {
  const rows = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  const out: Record<string, string> = {};
  rows.forEach((line, i) => {
    line.split("\t").forEach((v, j) => {
      const row = at.row + i;
      const col = at.col + j;
      if (row <= SHEET_ROWS && col <= SHEET_COLUMNS) out[cellName(row, col)] = v.trim();
    });
  });
  return out;
}

/** Results that read as numbers sit on the right, like in any spreadsheet. */
export const isNumber = (v: string) => /^[-+]?[$€£]?[\d,]*\.?\d+(e[-+]?\d+)?%?$/i.test(v.trim());
