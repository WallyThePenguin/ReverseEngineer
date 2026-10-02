// Fails when a source file is over the line limit (PLAN.md section 11).
// Files copied from other projects are exempt until changed; list them in NOTICE.md and here.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const LIMIT = 400;
const EXEMPT = new Set<string>([]);
const SOURCE = /\.(ts|tsx|js|rs|css)$/;

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
})
  .split("\n")
  .filter((f) => SOURCE.test(f) && !EXEMPT.has(f));

const over: string[] = [];
for (const file of files) {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const lines = text.split("\n").length;
  if (lines > LIMIT) over.push(`${file}: ${lines} lines`);
}

if (over.length > 0) {
  console.error(`Files over ${LIMIT} lines:\n  ${over.join("\n  ")}`);
  process.exit(1);
}
console.log(`${files.length} source files, all within ${LIMIT} lines.`);
