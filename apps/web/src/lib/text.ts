// Text handling the editor and renderer share: finding the @mention being typed, splitting a
// line into text and mentions, and ticking checklist items.

import { parseMentions, unescapeText } from "@hearth/core";

/** The "@query" being typed just before the caret, if any. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  // Up to four words, so "@Pay rent in May" still searches.
  const m = /(^|[\s(])@([^\s@[\]()]{0,30}(?: [^\s@[\]()]{1,30}){0,3})$/.exec(before);
  if (!m) return null;
  return { start: caret - m[2]!.length - 1, query: m[2]! };
}

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "mention"; type: string; id: string; label: string };

const TAG = /<m-ref\s+[^>]*>[\s\S]*?<\/m-ref>/g;

export function splitInline(line: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of line.matchAll(TAG)) {
    const mention = parseMentions(m[0])[0];
    if (m.index > last) out.push({ kind: "text", text: unescapeText(line.slice(last, m.index)) });
    if (mention)
      out.push({ kind: "mention", type: mention.type, id: mention.id, label: mention.label });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ kind: "text", text: unescapeText(line.slice(last)) });
  return out;
}

/** Flips "- [ ]" and "- [x]" on one line of a body. */
export function toggleLine(body: string, line: number): string {
  const lines = body.split("\n");
  const l = lines[line];
  if (l === undefined) return body;
  lines[line] = /\[( )\]/.test(l) ? l.replace("[ ]", "[x]") : l.replace(/\[(x|X)\]/, "[ ]");
  return lines.join("\n");
}

export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

/** What changed between two versions of a page, line by line (longest common subsequence). */
export function lineDiff(before: string, now: string): DiffLine[] {
  const a = before.split("\n");
  const b = now.split("\n");
  // Very long pages fall back to "was in it / is in it", which is cheap and still useful.
  if (a.length * b.length > 1_000_000) {
    const had = new Set(a);
    const has = new Set(b);
    return [
      ...a.filter((l) => !has.has(l)).map((text) => ({ kind: "removed" as const, text })),
      ...b.map((text) => ({ kind: had.has(text) ? ("same" as const) : ("added" as const), text })),
    ];
  }
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = lcs[i] as Uint32Array;
      const below = lcs[i + 1] as Uint32Array;
      row[j] =
        a[i] === b[j]
          ? (below[j + 1] as number) + 1
          : Math.max(below[j] as number, row[j + 1] as number);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] as string });
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      out.push({ kind: "removed", text: a[i++] as string });
    } else {
      out.push({ kind: "added", text: b[j++] as string });
    }
  }
  while (i < n) out.push({ kind: "removed", text: a[i++] as string });
  while (j < m) out.push({ kind: "added", text: b[j++] as string });
  return out;
}
