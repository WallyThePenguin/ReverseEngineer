// What a person's avatar shows (components/kit/Avatar.tsx): their initials on one of eight quiet
// tints. Hearth loads no photos: the CSP serves images only from Hearth, and it's more private.

/** How many tints there are: --color-avatar-1 to -8 in index.css. */
export const TINTS = 8;

/** A word's first letter or digit, so "(Dana)" and "'Dana'" both give D. */
function first(word: string): string {
  return Array.from(word.replace(/^[^\p{L}\p{N}]+/u, ""))[0] ?? "";
}

/**
 * Up to two letters for a person: their first and last names' ("Dana Ruiz" and "Ruiz, Dana" are
 * both DR), or their address's when there's no name ("dana.ruiz@" is DR, "dana@" is D). "?" when
 * there's neither.
 */
export function initials(name?: string | null, email?: string | null): string {
  let text = (name ?? "").replace(/<[^>]*>/g, " ").trim();
  let address = email ?? "";
  // A name that's really an address, as some senders' are.
  if (/^\S+@\S+$/.test(text)) [text, address] = ["", text];
  if (text.includes(",")) {
    // One word before the comma is a last name ("Ruiz, Dana"); more is a whole name with a title
    // or a company after it ("Dana Ruiz, MD"), which isn't part of the initials.
    const [before = "", ...after] = text.split(",");
    text = before.trim().split(/\s+/).length > 1 ? before : [...after, before].join(" ");
  }
  let words = text.split(/\s+/).filter((w) => first(w) !== "");
  if (words.length === 0) {
    // "dana.ruiz+news@" is Dana Ruiz's address with a tag on it.
    const local = address.trim().split("@")[0]?.split("+")[0] ?? "";
    words = local.split(/[._-]+/).filter((w) => first(w) !== "");
  }
  if (words.length === 0) return "?";
  const last = words.length > 1 ? first(words[words.length - 1]!) : "";
  return (first(words[0]!) + last).toLocaleUpperCase();
}

/**
 * Which tint (0 to 7) a person's avatar takes: from their address, so they keep it on every
 * screen whichever way their name is written. A stable hash (FNV-1a), not a random pick.
 */
export function tintOf(key: string): number {
  let hash = 0x811c9dc5;
  for (const char of key.trim().toLowerCase()) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % TINTS;
}
