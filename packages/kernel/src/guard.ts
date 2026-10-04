// D25/D30 for every call made as Jarvis (D58). Before such a call runs or waits for your yes,
// Hearth checks the page it would open (opensUrl), pins it to the page it acts on (pin), and
// captures what it will do (snapshot). Doing it here rather than in a turn's tools means a
// reflex's "act", a self-test step and a turn's tool call all get the same checks, and an approval
// you give later runs exactly what was checked and shown.
import { normalizeUrl, type SiteRules } from "@hearth/core";
import type { Kernel } from "./kernel.ts";
import { getSetting } from "./settings.ts";
import { checkActing, checkOpen, type TrustState } from "./trust.ts";
import type { ActionDef, Caller } from "./types.ts";

export type Guarded =
  | { kind: "run"; input: unknown; askFirst?: string }
  | { kind: "blocked"; reason: string }
  | { kind: "invalid"; error: unknown };

/** Whether an action has a page or records to check before Jarvis's call to it runs. */
export function isGuarded(def: ActionDef): boolean {
  return Boolean(def.opensUrl || def.pin || def.snapshot);
}

/** The input without a snapshot: Hearth fills that in, so what a caller put there is never shown. */
export function withoutGiven(def: ActionDef, raw: unknown): unknown {
  if (!def.snapshot || !raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const { snapshot: _given, ...rest } = raw as Record<string, unknown>;
  return rest;
}

/**
 * Checks a call made as Jarvis against D25 (what it may open) and D30 (where it may act), and
 * returns the input to run or ask about: pinned to its page and with its snapshot. `raw` is the
 * caller's input without a snapshot; `input` is it parsed.
 */
export async function guardAgentCall(
  kernel: Kernel,
  def: ActionDef,
  raw: unknown,
  input: unknown,
  caller: Caller,
): Promise<Guarded> {
  const trust = caller.trust;
  // A call without a turn's trust (a reflex, a self-test) has seen no addresses: if it came from
  // outside content, everything it opens or acts on outside your allowed sites needs your yes.
  const state: TrustState = {
    origin: caller.origin,
    seenUrls: trust?.seenUrls ?? new Set(),
    ...(trust?.vouchedHosts ? { vouchedHosts: trust.vouchedHosts } : {}),
  };
  let sites: SiteRules | undefined = trust?.sites;
  const siteRules = async () => {
    sites ??= await getSetting(kernel.db, "browser.sites");
    return sites;
  };
  let askFirst: string | undefined;
  let given = (raw ?? {}) as Record<string, unknown>;
  const parse = (value: unknown) => def.input.safeParse(value);

  const url = def.opensUrl?.(input);
  if (url) {
    const verdict = checkOpen(state, url, await siteRules());
    if (verdict.kind === "blocked") return verdict;
    if (verdict.kind === "ask") askFirst = verdict.reason;
  }
  if (def.pin) {
    const pinned = await def
      .pin(input, { service: (n) => kernel.services[n] as never })
      .catch(() => null);
    if (pinned && normalizeUrl(pinned.url)) {
      // Outward and destructive calls ask anyway; the rest are held to D30 after outside content.
      if (def.risk !== "outward" && def.risk !== "destructive") {
        const verdict = checkActing(state, pinned.url, await siteRules());
        if (verdict.kind === "ask") askFirst ??= verdict.reason;
      }
      // Pinned to the page it was checked on, should it run later after a yes.
      const site = typeof given.site === "string" ? given.site : new URL(pinned.url).hostname;
      given = { ...given, site, ...pinned.extra };
    } else if (state.origin === "untrusted") {
      askFirst ??= "Hearth couldn't tell which site this would act on.";
    }
  }
  if (def.snapshot) {
    const pinned = parse(given);
    if (!pinned.success) return { kind: "invalid", error: pinned.error };
    try {
      const snap = await def.snapshot(pinned.data, { db: kernel.db, now: kernel.clock.now() });
      given = { ...given, ...snap };
    } catch (err) {
      return { kind: "invalid", error: err };
    }
  }
  const done = parse(given);
  if (!done.success) return { kind: "invalid", error: done.error };
  return { kind: "run", input: done.data, ...(askFirst ? { askFirst } : {}) };
}
