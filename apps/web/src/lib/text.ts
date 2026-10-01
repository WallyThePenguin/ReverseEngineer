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
