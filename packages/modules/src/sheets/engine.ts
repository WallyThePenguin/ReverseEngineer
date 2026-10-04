// IronCalc on the server: the same engine the browser uses, loaded once from its WebAssembly.
// Evaluation is paused while the cells go in and run once at the end: left on, IronCalc works out
// the whole workbook after every cell, and a few thousand cells took seconds (D59).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { type CalcModel, calculate, type Results, type Workbook } from "@hearth/core";
import * as ironcalc from "@ironcalc/wasm";

let ready = false;

function model(timeZone: string): CalcModel {
  if (!ready) {
    const wasm = createRequire(import.meta.url).resolve("@ironcalc/wasm/wasm_bg.wasm");
    ironcalc.initSync({ module: readFileSync(wasm) });
    ready = true;
  }
  let m: ironcalc.Model;
  try {
    m = new ironcalc.Model("Workbook", "en", timeZone, "en");
  } catch {
    // A time zone IronCalc doesn't know: UTC rather than no results at all.
    m = new ironcalc.Model("Workbook", "en", "UTC", "en");
  }
  m.pauseEvaluation();
  return m;
}

/** Every formula's result, with NOW() and TODAY() in `timeZone` (the owner's). */
export const results = (book: Workbook, timeZone = "UTC"): Results =>
  calculate(book, () => model(timeZone));

/** Results that change with the clock or by chance can't be kept. */
const VOLATILE = /\b(NOW|TODAY|RAND|RANDBETWEEN|RANDARRAY)\s*\(/i;
const KEEP = 20;
const KEEP_MS = 5 * 60_000;
const kept = new Map<string, { at: number; results: Results }>();

/**
 * Results for a workbook as read back at a version. A version is written once, under the row's
 * lock (sheet.save), so a workbook read at a version always holds the same cells. Only reads
 * fill this: a save's own version can still roll back.
 */
export function resultsAt(id: string, version: number, book: Workbook, timeZone: string) {
  const key = `${id}@${version}@${timeZone}`;
  const hit = kept.get(key);
  if (hit && Date.now() - hit.at < KEEP_MS) {
    kept.delete(key);
    kept.set(key, hit);
    return hit.results;
  }
  const out = results(book, timeZone);
  if (book.sheets.some((s) => Object.values(s.cells).some((c) => VOLATILE.test(c)))) return out;
  kept.set(key, { at: Date.now(), results: out });
  for (const old of kept.keys()) {
    if (kept.size <= KEEP) break;
    kept.delete(old);
  }
  return out;
}
