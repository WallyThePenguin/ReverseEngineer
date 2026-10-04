// Reports what a fresh page load downloads from the built web app (apps/web/dist): the main
// script and the chunks index.html preloads with it. Fails if any of them holds Loro or loads
// WebAssembly (those belong in the doc editor's and spreadsheet's own chunks, fetched when one
// opens), or if the set grows past the budget. Also fails if the build's id is in them rather than
// in index.html: the main script would then be renamed by every commit, and the service worker,
// which tells builds apart by that name, would drop every cached file on each deploy.
// Run after `pnpm build:web`.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildId, type VersionStamp } from "./version-stamp.ts";

const DIST = process.argv[2] ?? "apps/web/dist";
/** Raw bytes of JavaScript a page load may fetch before anything shows. */
const BUDGET = 400 * 1024;

const html = readFileSync(join(DIST, "index.html"), "utf8");
const scripts = [
  ...html.matchAll(/<script[^>]+src="\/(assets\/[^"]+\.js)"/g),
  ...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/(assets\/[^"]+\.js)"/g),
].map((m) => m[1]!);
const stampFile = join(DIST, "version.json");
const stamp = existsSync(stampFile)
  ? (JSON.parse(readFileSync(stampFile, "utf8")) as VersionStamp)
  : null;
const build = stamp ? buildId(stamp) : null;

const kb = (n: number) => `${(n / 1024).toFixed(1)} kB`;
const problems: string[] = [];
if (build && html.match(/<meta name="hearth-build" content="([^"]*)"/)?.[1] !== build)
  problems.push("index.html doesn't name its build");
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
  if (build && text.includes(build)) problems.push(`${file} contains the build's id`);
}
console.log(`Main bundle: ${scripts.length} files, ${kb(raw)} (${kb(br)} as sent, brotli).`);
if (scripts.length === 0) problems.push("no scripts found in index.html");
if (raw > BUDGET) problems.push(`over the ${kb(BUDGET)} budget`);
if (problems.length) {
  console.error(`The main bundle has problems:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
