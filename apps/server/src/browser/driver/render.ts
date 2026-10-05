// A page's lines as text Jarvis reads (B1): one thing per line, indented by where it sits, each
// with its ref, like `- button "Add to cart" [ref_12]`, and `(asks owner)` on what would send.
import type { Line } from "./snapshot.ts";

export interface ReadOptions {
  /** "interactive": only what can be pressed or typed into, as a flat list. */
  filter: "all" | "interactive";
  depth: number;
  refId?: string;
  maxChars: number;
}

const quote = (s: string) => JSON.stringify(s.length > 150 ? `${s.slice(0, 150)}…` : s);

/** One line's text, without its indent. */
export function lineText(l: Line): string {
  if (l.text) return `text ${quote(l.name)}`;
  let s = l.role;
  if (l.name) s += ` ${quote(l.name)}`;
  if (l.ref) s += ` [${l.ref}]`;
  if (l.value !== undefined) s += ` value=${quote(l.value)}`;
  if (l.props.length) s += ` (${l.props.join(", ")})`;
  if (l.site) s += ` from ${l.site}`;
  if (l.url) s += ` -> ${l.url.length > 200 ? `${l.url.slice(0, 200)}…` : l.url}`;
  if (l.asks) s += ` (${l.asks})`;
  return s;
}

function findRef(lines: Line[], ref: string): Line | null {
  for (const l of lines) {
    if (l.ref === ref) return l;
    const inner = findRef(l.children, ref);
    if (inner) return inner;
  }
  return null;
}

/** The lines as text, cut at maxChars; null when refId isn't on the page. */
export function render(lines: Line[], opts: ReadOptions): { text: string; cut: boolean } | null {
  let roots = lines;
  if (opts.refId) {
    const at = findRef(lines, opts.refId);
    if (!at) return null;
    roots = [at];
  }
  const out: string[] = [];
  let size = 0;
  let cut = false;
  const push = (s: string) => {
    if (cut) return;
    if (size + s.length + 1 > opts.maxChars) {
      cut = true;
      return;
    }
    out.push(s);
    size += s.length + 1;
  };
  const visit = (l: Line, depth: number) => {
    if (cut) return;
    if (opts.filter === "interactive") {
      if (l.interactive || l.role === "iframe") push(`- ${lineText(l)}`);
    } else if (depth < opts.depth) push(`${"  ".repeat(depth)}- ${lineText(l)}`);
    for (const c of l.children) visit(c, depth + 1);
  };
  for (const l of roots) visit(l, 0);
  return { text: out.join("\n"), cut };
}

/** Every line with a ref, in page order. */
export function flatten(lines: Line[], out: Line[] = []): Line[] {
  for (const l of lines) {
    if (l.ref) out.push(l);
    flatten(l.children, out);
  }
  return out;
}

/**
 * The things that best match a query, by the words in their names, roles and values: an exact
 * name first, then the most words found.
 */
export function find(lines: Line[], query: string, max = 20): Line[] {
  const q = query.toLowerCase().trim();
  const words = q.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 || /\d/.test(w));
  const scored = flatten(lines).flatMap((l, n) => {
    const name = l.name.toLowerCase();
    let score = name === q ? 10 : name.includes(q) && q ? 6 : 0;
    for (const w of words) {
      if (name.includes(w)) score += 3;
      if (l.role.includes(w)) score += 2;
      if (l.value?.toLowerCase().includes(w)) score += 1;
      if (l.url?.toLowerCase().includes(w)) score += 1;
    }
    if (score > 0 && l.interactive) score += 1;
    return score > 0 ? [{ l, score, n }] : [];
  });
  scored.sort((a, b) => b.score - a.score || a.n - b.n);
  return scored.slice(0, max).map((s) => s.l);
}

/** What each ref showed, for telling what an action changed. */
export function shownByRef(lines: Line[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of flatten(lines))
    if (l.interactive || l.role === "dialog" || l.role === "alert")
      out.set(l.ref ?? "", lineText(l));
  return out;
}

const MAX_CHANGES = 15;

/** What an action changed on the page: things that came or changed, and refs that went. */
export function changes(before: Map<string, string>, after: Map<string, string>) {
  const added: string[] = [];
  const removed: string[] = [];
  for (const [ref, text] of after) if (before.get(ref) !== text) added.push(`- ${text}`);
  for (const ref of before.keys()) if (!after.has(ref)) removed.push(ref);
  return {
    ...(added.length ? { shown: added.slice(0, MAX_CHANGES) } : {}),
    ...(added.length > MAX_CHANGES ? { more: added.length - MAX_CHANGES } : {}),
    ...(removed.length ? { gone: removed.slice(0, MAX_CHANGES) } : {}),
  };
}
