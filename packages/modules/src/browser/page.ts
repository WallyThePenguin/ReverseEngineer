// Looking at a page in your Chrome: wait for it to load, read it as text in an isolated world,
// and remember its links so Jarvis can follow one by reference ("L4") instead of retyping it.
import { readFileSync } from "node:fs";
import { ActionError } from "@hearth/kernel";
import type { BrowserClient, TabInfo } from "./client.ts";

const SOURCE = readFileSync(new URL("./page-snapshot.js", import.meta.url), "utf8");
const SNAPSHOT = SOURCE.slice(SOURCE.indexOf("function pageSnapshot"));

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  /** Link addresses; "L1" is links[0]. */
  links: string[];
  truncated: boolean;
  /** A selector was given and nothing on the page matched it. */
  missing: boolean;
}

/** The page-side reader as an expression, for Runtime.evaluate (and tests in a real browser). */
export function snapshotExpression(maxChars: number, selector?: string): string {
  return `(${SNAPSHOT})(${JSON.stringify({ maxChars, ...(selector ? { selector } : {}) })})`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long to wait for pages: before a navigation shows, between checks, and after a load. */
export const loadTiming = { startMs: 400, pollMs: 300, settleMs: 500 };

export async function findTab(client: BrowserClient, tabId: number): Promise<TabInfo> {
  const tabs = await client.call<TabInfo[]>("tabs.list");
  const tab = tabs.find((t) => t.tabId === tabId);
  if (!tab)
    throw new ActionError("not_found", `Tab ${tabId} is closed, or isn't one Jarvis may use.`);
  return tab;
}

/** Waits for a tab to finish loading, then a moment more for pages that draw with scripts. */
export async function waitForLoad(
  client: BrowserClient,
  tabId: number,
  timeoutMs = 20_000,
): Promise<TabInfo> {
  const deadline = Date.now() + timeoutMs;
  // A navigation can take a moment to show as loading.
  await sleep(loadTiming.startMs);
  for (;;) {
    const tab = await findTab(client, tabId);
    if (!tab.loading) {
      await sleep(loadTiming.settleMs);
      return tab;
    }
    if (Date.now() > deadline) return tab;
    await sleep(loadTiming.pollMs);
  }
}

/** Runs an expression in a fresh isolated world on the tab's page and returns its value. */
export async function evaluate<T>(
  client: BrowserClient,
  tabId: number,
  expression: string,
): Promise<T> {
  const cdp = <R>(method: string, params: Record<string, unknown> = {}) =>
    client.call<R>("cdp", { tabId, method, params });
  const tree = await cdp<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
  const world = await cdp<{ executionContextId: number }>("Page.createIsolatedWorld", {
    frameId: tree.frameTree.frame.id,
    worldName: "hearth",
  });
  const res = await cdp<{
    result?: { value?: unknown };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  }>("Runtime.evaluate", {
    expression,
    contextId: world.executionContextId,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    const why = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text;
    throw new ActionError("failed", `The page couldn't be read: ${why.split("\n")[0]}`);
  }
  return res.result?.value as T;
}

export function readPage(
  client: BrowserClient,
  tabId: number,
  maxChars: number,
  selector?: string,
): Promise<PageSnapshot> {
  return evaluate<PageSnapshot>(client, tabId, snapshotExpression(maxChars, selector));
}

// The links of the last page read in each tab. Kept in this process only, which is the one
// Jarvis runs in, so a reference is good until the tab is read again.
const MAX_PAGES = 50;
const pageLinks = new Map<number, { url: string; links: string[] }>();

export function rememberLinks(tabId: number, url: string, links: string[]): void {
  pageLinks.delete(tabId);
  pageLinks.set(tabId, { url, links });
  const oldest = pageLinks.keys().next().value;
  if (pageLinks.size > MAX_PAGES && oldest !== undefined) pageLinks.delete(oldest);
}

/** The address behind "L4" on the page last read in a tab, or null. */
export function linkUrl(tabId: number, ref: string): string | null {
  const n = /^L(\d+)$/i.exec(ref.trim());
  if (!n) return null;
  return pageLinks.get(tabId)?.links[Number(n[1]) - 1] ?? null;
}

export function forgetLinks(tabId: number): void {
  pageLinks.delete(tabId);
}
