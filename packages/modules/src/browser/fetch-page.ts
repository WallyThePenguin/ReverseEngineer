// Plain fetches, for page watches on public pages: no cookies and no Chrome, so they work while
// Chrome is closed. HTML becomes rough text; text hidden outright in the markup is dropped.
import { ActionError } from "@hearth/kernel";

// Zero-width characters, bidi overrides and Unicode "tag" characters can hide text in plain sight.
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/gu;
const MAX_BYTES = 2_000_000;

/** Addresses on this PC or your home network. Only you may point a plain fetch at them. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return true;
  if (h === "::1" || h === "::" || /^(fc|fd|fe80)/.test(h)) return true;
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  euro: "€",
  pound: "£",
  copy: "©",
};

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n =
        code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    }
    return NAMED[code.toLowerCase()] ?? whole;
  });
}

/** Strips invisible characters and blank lines, and squeezes spaces. */
export function tidyText(s: string): string {
  return s
    .replace(INVISIBLE, "")
    .split("\n")
    .map((line) => line.replace(/[ \t\r\f\v ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

const BLOCK_TAGS =
  "p|div|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|nav|main|aside|blockquote|pre|dd|dt|form";

/** A web page's title and visible text, roughly. Nested hidden elements aren't tracked exactly. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<(script|style|noscript|template|svg|head|title|iframe|object)\b[\s\S]*?<\/\1\s*>/gi,
      " ",
    )
    // Elements hidden in their own markup: hidden, aria-hidden, display:none, visibility:hidden.
    .replace(
      /<([a-z][a-z0-9]*)\b(?=[^>]*(?:\shidden\b|aria-hidden\s*=\s*["']?true|style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)))[^>]*>[\s\S]*?<\/\1\s*>/gi,
      " ",
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(new RegExp(`</?(${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n")
    .replace(/<[^>]+>/g, " ");
  return { title, text: tidyText(decode(body)) };
}

/**
 * Fetches a page without cookies and returns its text. Each redirect is checked, so a public
 * address can't bounce the request onto your home network unless `allowPrivate` is set.
 */
export async function fetchPageText(
  url: string,
  opts: { allowPrivate: boolean },
): Promise<{ url: string; title: string; text: string }> {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const host = new URL(current).hostname;
    if (!opts.allowPrivate && isPrivateHost(host))
      throw new ActionError("forbidden", `${host} is on your own network; only you can watch it.`);
    let res: Response;
    try {
      res = await fetch(current, {
        redirect: "manual",
        headers: { "user-agent": "Hearth page watch", accept: "text/html, text/plain;q=0.9" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new ActionError("failed", `Couldn't reach ${host}: ${(err as Error).message}`);
    }
    const next = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && next) {
      current = new URL(next, current).href;
      if (!/^https?:/.test(current)) throw new ActionError("failed", "It redirected off the web.");
      continue;
    }
    if (!res.ok) throw new ActionError("failed", `${host} answered ${res.status}.`);
    const type = res.headers.get("content-type") ?? "";
    const raw = (await res.text()).slice(0, MAX_BYTES);
    if (type.includes("html")) return { url: current, ...htmlToText(raw) };
    if (type.startsWith("text/") || type.includes("json"))
      return { url: current, title: "", text: tidyText(raw) };
    throw new ActionError("failed", `${host} sent ${type || "something"}, not a web page.`);
  }
  throw new ActionError("failed", "Too many redirects.");
}
