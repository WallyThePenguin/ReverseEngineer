// After a step (B1): waiting for what it set off by the page's own signals, not fixed sleeps (a new
// page's load, or the page going quiet), then saying briefly where things stand: the address and
// title, whether a new page came, a dialog or new tabs it opened, and what changed on the page.
import type { DriverContext } from "./context.ts";
import { fail } from "./errors.ts";
import { changes, shownByRef } from "./render.ts";
import { readTree } from "./snapshot.ts";

/** A new page gets this long to load before the step reports it as still loading. */
const LOAD_MS = 8_000;
/** The page counts as settled after this long without changes, or this long at most. */
const QUIET_MS = 120;
const QUIET_MAX_MS = 1_500;

export interface Before {
  navigations: number;
  url: string;
  tabs: Set<number>;
}

/** What to compare a step against afterwards. */
export async function before(d: DriverContext): Promise<Before> {
  const tabs = await d.transport.call<{ tabId: number }[]>("tabs.list").catch(() => []);
  return { navigations: d.tab.navigations, url: d.url(), tabs: new Set(tabs.map((t) => t.tabId)) };
}

/** Waits for a new page to load, or for the page to go quiet. Says whether a new page came. */
export async function settle(
  d: DriverContext,
  b: Before,
): Promise<{ navigated: boolean; loading: boolean }> {
  const tab = d.tab;
  const moved = () => tab.navigations !== b.navigations || tab.starting;
  const main = tab.mainFrame ?? "";
  // The page goes quiet unless a navigation starts first; a navigation takes the world with it.
  const quiet = d.worlds
    .evaluate(undefined, main, `__hearth.quiet(${QUIET_MS}, ${QUIET_MAX_MS})`)
    .then(
      () => "quiet" as const,
      () => "gone" as const,
    );
  const first = await Promise.race([
    quiet,
    tab.waitFor(moved, QUIET_MAX_MS + 200).then(() => "moved" as const),
  ]);
  if (tab.dialog) return { navigated: false, loading: false };
  if (first === "quiet" && !moved()) return { navigated: false, loading: false };
  // A new page: wait for it to load (its lifecycle's "load"), or for loading to stop.
  const loaded = () => {
    if (tab.dialog) return true;
    if (tab.navigations === b.navigations) return !tab.starting;
    const steps = tab.mainFrame ? tab.lifecycle.get(tab.mainFrame) : undefined;
    return Boolean(steps?.has("load")) || !tab.starting;
  };
  const done = await tab.waitFor(loaded, LOAD_MS);
  return { navigated: tab.navigations !== b.navigations, loading: !done };
}

/** Steps back from a blocked site a step led to, and refuses the step. */
export async function stepBack(d: DriverContext, b: Before): Promise<void> {
  const now = d.url();
  if (!now || now === b.url) return;
  try {
    d.assertAllowed(now);
  } catch (err) {
    await d.cdp.send("Page.navigate", { url: b.url }).catch(() => {});
    throw err;
  }
}

/** Where things stand after a step, in a few lines. */
export async function after(
  d: DriverContext,
  b: Before,
  did: string,
  s: { navigated: boolean; loading: boolean },
) {
  const history = await d.cdp
    .send<{ currentIndex: number; entries: { url: string; title: string }[] }>(
      "Page.getNavigationHistory",
    )
    .catch(() => null);
  const entry = history?.entries[history.currentIndex];
  const tabs = await d.transport
    .call<{ tabId: number; url: string }[]>("tabs.list")
    .catch(() => []);
  const opened = tabs
    .filter((t) => !b.tabs.has(t.tabId))
    .map((t) => ({ tabId: t.tabId, url: t.url }));
  let changed: Record<string, unknown> | undefined;
  if (!s.navigated && !d.tab.dialog && d.tab.last) {
    const now = shownByRef((await readTree(d)).lines);
    changed = changes(d.tab.last, now);
    d.tab.last = now;
  }
  const notes: string[] = [];
  if (d.tab.dialog)
    notes.push(
      `A ${d.tab.dialog.type} dialog opened; answer it with browser_dialog before anything else in this tab.`,
    );
  if (s.navigated)
    notes.push(
      "A new page loaded: its refs are new, so read it (browser_read_page or browser_find).",
    );
  if (s.loading) notes.push("The page is still loading.");
  for (const t of opened) notes.push(`It opened tab ${t.tabId}.`);
  return {
    tabId: d.tab.tabId,
    did,
    url: entry?.url ?? d.url(),
    title: (entry?.title ?? "").slice(0, 200),
    navigated: s.navigated,
    ...(s.loading ? { loading: true } : {}),
    ...(d.tab.dialog
      ? { dialog: { type: d.tab.dialog.type, message: d.tab.dialog.message.slice(0, 500) } }
      : {}),
    ...(opened.length ? { opened } : {}),
    ...(changed && Object.keys(changed).length ? { changed } : {}),
    ...(notes.length ? { next: notes.join(" ") } : {}),
  };
}

/** Steps don't wait on a tab the owner is using right now in Hearth's live view. */
export const OWNER_MS = 5_000;

export function assertFree(d: DriverContext): void {
  if (d.tab.dialog)
    throw fail(
      "dialog_open",
      `A ${d.tab.dialog.type} dialog is open on this page, and nothing else happens there until it's answered. Answer it with browser_dialog.`,
    );
  if (!d.policy.owner && Date.now() - d.tab.ownerAt < OWNER_MS)
    throw fail(
      "owner_in_control",
      "The owner is using this tab right now in Hearth's live view. Wait a moment, or ask them.",
    );
}
