// Writes the web app's theme stylesheets from Nook's design-system tokens:
//   node scripts/nook-themes.ts          rewrite apps/web/src/styles/{nook.css,themes/*.css}
//   node scripts/nook-themes.ts --check  exit 1 if any of them is out of date
// design/nook/tokens.json is the one source. lib/tokens.test.ts makes the same check.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type NookTokens, renderNook } from "../apps/web/src/lib/nookTokens.ts";

const root = join(import.meta.dirname, "..");
const tokens = JSON.parse(
  readFileSync(join(root, "design/nook/tokens.json"), "utf8"),
) as NookTokens;
const check = process.argv.includes("--check");
const stale: string[] = [];

for (const [path, text] of Object.entries(renderNook(tokens))) {
  const file = join(root, "apps/web/src/styles", path);
  let now = "";
  try {
    now = readFileSync(file, "utf8");
  } catch {}
  if (now === text) continue;
  if (check) stale.push(path);
  else {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    console.log(`wrote apps/web/src/styles/${path}`);
  }
}

if (stale.length) {
  console.error(`Out of date: ${stale.join(", ")}. Run node scripts/nook-themes.ts.`);
  process.exit(1);
}
