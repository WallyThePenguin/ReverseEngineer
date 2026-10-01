// The brief and journal, rendered from every module's digest. Jarvis writes the final text;
// this deterministic version is what it works from, and what you get if it can't run.
import { formatDateTime } from "@hearth/core";
import type { DigestItem, DigestSection } from "@hearth/kernel";

const ORDER: { bucket: DigestItem["bucket"]; heading: string }[] = [
  { bucket: "handled", heading: "Handled" },
  { bucket: "prepared", heading: "Prepared" },
  { bucket: "needs_yes", heading: "Needs a yes" },
  { bucket: "today", heading: "Today" },
  { bucket: "fyi", heading: "Also" },
];

export function renderDigest(sections: DigestSection[]): string {
  const blocks: string[] = [];
  for (const { bucket, heading } of ORDER) {
    const items = sections.flatMap((s) => s.items.filter((i) => i.bucket === bucket));
    if (items.length === 0) continue;
    blocks.push(`## ${heading}\n${items.map((i) => `- ${i.text}`).join("\n")}`);
  }
  return blocks.length ? blocks.join("\n\n") : "Nothing needs you. Quiet day so far.";
}

export function renderBrief(sections: DigestSection[], now: Date): string {
  return `Brief for ${formatDateTime(now)}\n\n${renderDigest(sections)}`;
}

export function isEmptyDigest(sections: DigestSection[]): boolean {
  return sections.every((s) => s.items.length === 0);
}
