// Turning what you said into what you meant (PLAN.md section 7.2), in two passes: a fast rules
// pass that always runs, then an optional small local model for punctuation and tone. Your
// dictionary and snippets apply in the rules pass, so they hold even when the model is off.

export interface DictionaryEntry {
  /** What the engine tends to hear, or null for a term you only want spelled your way. */
  heard: string | null;
  write: string;
}

export interface Snippet {
  /** The words you say. */
  trigger: string;
  text: string;
}

export interface VoiceStyle {
  name: string;
  /** Matched against the app and window you're dictating into, ignoring case. */
  match: string;
  /** How the model should write there ("casual, no capital letters"). */
  instructions: string;
}

const FILLERS = /(^|[\s,])(?:u+m+|u+h+m*|e+r+m+|e+h+|h+m+)(?=[\s,.!?]|$)[,]?/gi;
const SCRATCH = /\b(?:scratch that|strike that|delete that)\b[,.!?]?/i;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A phrase as a whole-word, case-insensitive pattern. */
const phrase = (s: string) => new RegExp(`(?<![\\w-])${escapeRe(s.trim())}(?![\\w-])`, "gi");

/** Drops what came before "scratch that", back to the start of that sentence. */
function scratch(text: string): string {
  let out = text;
  for (let i = 0; i < 20; i++) {
    const m = SCRATCH.exec(out);
    if (!m) break;
    const before = out.slice(0, m.index);
    const cut = Math.max(
      before.lastIndexOf(". "),
      before.lastIndexOf("! "),
      before.lastIndexOf("? "),
    );
    out = `${cut >= 0 ? before.slice(0, cut + 2) : ""}${out.slice(m.index + m[0].length).trimStart()}`;
  }
  return out;
}

/** Fillers, false starts, repeated words, spacing and the first capital. */
export function tidy(raw: string): string {
  let t = raw.replace(/\s+/g, " ").trim();
  t = t.replace(FILLERS, "$1");
  t = scratch(t);
  // "the the" and "I I", said while thinking.
  t = t.replace(/\b(\w+)(?:\s+\1\b)+/gi, "$1");
  t = t
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/,(\s*[,.!?])/g, "$1")
    .replace(/^[,.;:\s]+/, "")
    .replace(/\s+/g, " ")
    .replace(/([.!?]\s+)([a-z])/g, (_m, gap: string, c: string) => gap + c.toUpperCase())
    .trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
}

/** Your spellings: "auto pair" becomes "OtoPair". Longest first, so phrases beat single words. */
export function applyDictionary(text: string, entries: DictionaryEntry[]): string {
  let t = text;
  const swaps = entries
    .filter((e): e is { heard: string; write: string } => Boolean(e.heard?.trim()))
    .sort((a, b) => b.heard.length - a.heard.length);
  for (const e of swaps) t = t.replace(phrase(e.heard), () => e.write);
  return t;
}

/** Saying a snippet's words puts its text in their place. */
export function expandSnippets(text: string, snippets: Snippet[]): string {
  let t = text;
  for (const s of [...snippets].sort((a, b) => b.trigger.length - a.trigger.length)) {
    if (!s.trigger.trim()) continue;
    t = t.replace(phrase(s.trigger), () => s.text);
  }
  return t;
}

/** The style for where you're dictating: the first whose match is in the app or window. */
export function pickStyle(
  styles: VoiceStyle[],
  app: string | null,
  window: string | null,
): VoiceStyle | null {
  const where = `${app ?? ""}\n${window ?? ""}`.toLowerCase();
  return styles.find((s) => s.match.trim() && where.includes(s.match.trim().toLowerCase())) ?? null;
}

/** The rules pass, in order: tidy, then your words, then snippets (whose text stays as written). */
export function rulesPass(raw: string, dictionary: DictionaryEntry[], snippets: Snippet[]): string {
  return expandSnippets(applyDictionary(tidy(raw), dictionary), snippets);
}

/**
 * Word swaps between what was written and what you fixed it to, for the dictionary to learn:
 * runs of one to three words replaced by one to three others. Nothing for rewrites.
 */
export function learnedSwaps(before: string, after: string): { heard: string; write: string }[] {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  const bare = (w: string) => w.replace(/^[^\w]+|[^\w]+$/g, "");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const from = a.slice(start, endA).map(bare).join(" ").trim();
  const to = b.slice(start, endB).map(bare).join(" ").trim();
  if (!from || !to || (from.toLowerCase() === to.toLowerCase() && from === to)) return [];
  if (endA - start > 3 || endB - start > 3) return [];
  return [{ heard: from, write: to }];
}
