// IronCalc on the server: the same engine the browser uses, loaded once from its WebAssembly.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { type CalcModel, calculate, type Results, type Workbook } from "@hearth/core";
import * as ironcalc from "@ironcalc/wasm";

let ready = false;

function model(): CalcModel {
  if (!ready) {
    const wasm = createRequire(import.meta.url).resolve("@ironcalc/wasm/wasm_bg.wasm");
    ironcalc.initSync({ module: readFileSync(wasm) });
    ready = true;
  }
  return new ironcalc.Model("Workbook", "en", "UTC", "en");
}

export const results = (book: Workbook): Results => calculate(book, model);
