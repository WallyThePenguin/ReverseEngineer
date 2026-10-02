// What a turn may open once it has read outside content (D25). An untrusted turn can follow exact
// addresses that appeared in what it read, or open sites you allowed. Anything else could be a
// page smuggling your data out in a URL, so it needs your yes (or, for a web fetch, is refused).
import type { Origin, SiteRules } from "@hearth/core";

export type { SiteRules };

export interface TrustState {
  origin: Origin;
  /** Every web address that appeared in outside content this turn. */
  seenUrls: Set<string>;
}

export type OpenVerdict =
  | { kind: "ok" }
  | { kind: "blocked"; reason: string }
  | { kind: "ask"; reason: string };

/** An http(s) address without its #fragment, or null if it isn't one. */
export function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

/** True when the host is one of the sites, or a subdomain of one. */
export function onSiteList(host: string, sites: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return sites.some((s) => {
    const site = s.trim().toLowerCase().replace(/^\*\./, "");
    return site !== "" && (h === site || h.endsWith(`.${site}`));
  });
}

const URL_PATTERN = /https?:\/\/[^\s"'<>`\\{}|^[\]]+/g;

/** Web addresses mentioned in a piece of text, normalized. */
export function extractUrls(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(URL_PATTERN)) {
    const url = normalizeUrl(m[0].replace(/[.,;:!?)]+$/, ""));
    if (url) found.add(url);
  }
  return [...found];
}

/** Marks the turn untrusted and remembers the addresses it just read. */
export function readOutsideContent(state: TrustState, text: string): void {
  state.origin = "untrusted";
  for (const url of extractUrls(text)) state.seenUrls.add(url);
}

export function checkOpen(state: TrustState, raw: string, sites: SiteRules): OpenVerdict {
  const url = normalizeUrl(raw);
  if (!url) return { kind: "blocked", reason: `${raw} isn't a web address Jarvis can open.` };
  const host = new URL(url).hostname;
  if (onSiteList(host, sites.blocked))
    return {
      kind: "blocked",
      reason: `${host} is on the owner's list of sites Jarvis never opens.`,
    };
  if (state.origin !== "untrusted") return { kind: "ok" };
  if (state.seenUrls.has(url) || onSiteList(host, sites.allowed)) return { kind: "ok" };
  return {
    kind: "ask",
    reason: `This turn read outside content, and ${url} didn't appear in it, so opening it needs your yes.`,
  };
}
