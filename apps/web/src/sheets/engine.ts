// IronCalc in the browser: the same engine the server uses, loaded the first time a spreadsheet
// opens (about 2 MB), so results update as you type. Evaluation is paused while the cells go in
// (D59), and NOW() and TODAY() follow this device's clock and time zone.
import { calculate, type Results, type Workbook } from "@hearth/core";

let ready: Promise<(book: Workbook) => Results> | null = null;

function timeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function engine() {
  ready ??= import("@ironcalc/wasm").then(async (m) => {
    await m.default();
    const zone = timeZone();
    const model = () => {
      let made: InstanceType<typeof m.Model>;
      try {
        made = new m.Model("Workbook", "en", zone, "en");
      } catch {
        made = new m.Model("Workbook", "en", "UTC", "en");
      }
      made.pauseEvaluation();
      return made;
    };
    return (book: Workbook) => calculate(book, model);
  });
  return ready;
}
