// Reports what a fresh page load downloads from the built web app (apps/web/dist): the main
// script and the chunks index.html preloads with it. Fails if any of them holds Loro or loads
// WebAssembly (those belong in the doc editor's and spreadsheet's own chunks, fetched when one
// opens), or if the set grows past the budget. Run after `pnpm build:web`.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = process.argv[2] ?? "apps/web/dist";
/** Raw bytes of JavaScript a page load may fetch before anything shows. */
const BUDGET = 400 * 1024;

const html = readFileSync(join(DIST, "index.html"), "utf8");
const scripts = [
  ...html.matchAll(/<script[^>]+src="\/(assets\/[^"]+\.js)"/g),
  ...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/(assets\/[^"]+\.js)"/g),
].map((m) => m[1]!);

const kb = (n: number) => `${(n / 1024).toFixed(1)} kB`;
const problems: string[] = [];
let raw = 0;
let br = 0;
for (const file of scripts) {
  const path = join(DIST, file);
  const text = readFileSync(path, "utf8");
  const size = statSync(path).size;
  const small = existsSync(`${path}.br`) ? statSync(`${path}.br`).size : size;
  raw += size;
  br += small;
  console.log(`  ${file.padEnd(40)} ${kb(size).padStart(10)} ${kb(small).padStart(10)} br`);
  if (/loro/i.test(text)) problems.push(`${file} contains Loro`);
  if (/\.wasm\b/.test(text)) problems.push(`${file} loads WebAssembly`);
}
console.log(`Main bundle: ${scripts.length} files, ${kb(raw)} (${kb(br)} as sent, brotli).`);
if (scripts.length === 0) problems.push("no scripts found in index.html");
if (raw > BUDGET) problems.push(`over the ${kb(BUDGET)} budget`);
if (problems.length) {
  console.error(`The main bundle has problems:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
