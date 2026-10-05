// The markdown Hearth shows: what Jarvis writes in its answers (headings, lists, numbered steps,
// links, code, tables, quotes) and what you write in bodies. It's read into plain pieces that are
// drawn as DOM, never as HTML, so nothing in a message can run or style itself.

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong" | "em" | "code" | "strike"; text: string }
  | { kind: "link"; text: string; href: string };

const INLINE = new RegExp(
  [
    /`[^`\n]+`/.source,
    /\*\*[^*\n]+\*\*/.source,
    /~~[^~\n]+~~/.source,
    /\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^\s)]+\)/.source,
    /https?:\/\/[^\s<]*[^\s<.,;:!?)\]'"]/.source,
    /(?<![\w*])\*[^*\s][^*\n]*?\*(?![\w*])/.source,
    /(?<![\w_])_[^_\s][^_\n]*?_(?![\w_])/.source,
  ].join("|"),
  "g",
);

/** Bold, italics, strikethrough, `code`, [links](https://…) and bare links in one line. */
export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const s = m[0];
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    last = m.index + s.length;
    if (s.startsWith("`")) out.push({ kind: "code", text: s.slice(1, -1) });
    else if (s.startsWith("**")) out.push({ kind: "strong", text: s.slice(2, -2) });
    else if (s.startsWith("~~")) out.push({ kind: "strike", text: s.slice(2, -2) });
    else if (s.startsWith("[")) {
      const close = s.indexOf("](");
      out.push({ kind: "link", text: s.slice(1, close), href: s.slice(close + 2, -1) });
    } else if (s.startsWith("http")) out.push({ kind: "link", text: s, href: s });
    else out.push({ kind: "em", text: s.slice(1, -1) });
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

export type Block =
  | { kind: "line"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "bullet"; text: string; depth: number }
  | { kind: "number"; n: number; text: string; depth: number }
  | { kind: "check"; text: string; done: boolean; line: number }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "rule" };

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
const isDivider = (row: string | undefined) =>
  row !== undefined && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(row);

/** One line that isn't part of a code fence or a table. */
function lineBlock(line: string, i: number): Block {
  const depth = (indent: string) => Math.min(3, Math.floor(indent.length / 2));
  const heading = line.match(/^(#{1,6}) (.*)$/);
  if (heading) return { kind: "heading", level: heading[1]!.length, text: heading[2]! };
  const check = line.match(/^\s*[-*] \[( |x|X)\] (.*)$/);
  if (check) return { kind: "check", text: check[2]!, done: check[1] !== " ", line: i };
  const bullet = line.match(/^(\s*)[-*+] (.*)$/);
  if (bullet) return { kind: "bullet", text: bullet[2]!, depth: depth(bullet[1]!) };
  const num = line.match(/^(\s*)(\d{1,4})[.)] (.*)$/);
  if (num) return { kind: "number", n: Number(num[2]), text: num[3]!, depth: depth(num[1]!) };
  const quote = line.match(/^> ?(.*)$/);
  if (quote) return { kind: "quote", text: quote[1]! };
  if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return { kind: "rule" };
  return { kind: "line", text: line };
}

/** A body, block by block. A checklist item keeps its line number, for ticking it. */
export function blocks(body: string): Block[] {
  const lines = body.split("\n");
  const out: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i]!)) code.push(lines[i]!);
      out.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    if (line.includes("|") && isDivider(lines[i + 1])) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|")) rows.push(cells(lines[i++]!));
      i--;
      out.push({ kind: "table", head, rows });
      continue;
    }
    out.push(lineBlock(line, i));
  }
  return out;
}
