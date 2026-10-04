// IronCalc in the browser: the same engine the server uses, loaded the first time a spreadsheet
// opens (about 2 MB), so results update as you type.
import { calculate, type Results, type Workbook } from "@hearth/core";

let ready: Promise<(book: Workbook) => Results> | null = null;

export function engine() {
  ready ??= import("@ironcalc/wasm").then(async (m) => {
    await m.default();
    return (book: Workbook) => calculate(book, () => new m.Model("Workbook", "en", "UTC", "en"));
  });
  return ready;
}
