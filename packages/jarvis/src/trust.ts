// What a turn may open once it has read outside content (D25). An untrusted turn can follow exact
// addresses that appeared in what it read, or open sites you allowed. Anything else could be a
// page smuggling your data out in a URL, so it needs your yes (or, for a web fetch, is refused).
import { normalizeUrl, type Origin, onSiteList, type SiteRules } from "@hearth/core";

export { normalizeUrl, onSiteList, type SiteRules };

export interface TrustState {
  origin: Origin;
  /** Every web address that appeared in outside content this turn. */
  seenUrls: Set<string>;
  /** Sites this turn opened before it read anything from outside (D30). */
  vouchedHosts?: Set<string>;
}

export type OpenVerdict =
  | { kind: "ok" }
  | { kind: "blocked"; reason: string }
  | { kind: "ask"; reason: string };

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

/**
 * D30: once a turn has read outside content, Jarvis types, clicks and chooses freely only on sites
 * the turn opened before that, or sites you allowed. Elsewhere a page could have steered it there,
 * to collect what it types or to have it press things, so it needs your yes.
 */
export function checkActing(state: TrustState, raw: string, sites: SiteRules): OpenVerdict {
  if (state.origin !== "untrusted") return { kind: "ok" };
  const url = normalizeUrl(raw);
  if (!url) return { kind: "ok" };
  const host = new URL(url).hostname;
  if (state.vouchedHosts?.has(host) || onSiteList(host, sites.allowed)) return { kind: "ok" };
  return {
    kind: "ask",
    reason: `This turn read outside content and then went to ${host}, so acting there needs your yes. Adding ${host} to the sites Jarvis may use freely skips this.`,
  };
}

/** Remembers a site opened while the turn was still trusted. */
export function vouchFor(state: TrustState, raw: string): void {
  const url = normalizeUrl(raw);
  if (!url || state.origin === "untrusted") return;
  state.vouchedHosts ??= new Set();
  state.vouchedHosts.add(new URL(url).hostname);
}
