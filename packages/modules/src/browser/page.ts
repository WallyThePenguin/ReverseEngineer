// Looking at a page in your Chrome: wait for it to load, read it as text in an isolated world,
// and remember its links so Jarvis can follow one by reference ("L4") instead of retyping it.
import { readFileSync } from "node:fs";
import { ActionError } from "@hearth/kernel";
import { PAGE_RULES } from "./classify.ts";
import type { BrowserClient, TabInfo } from "./client.ts";

/** A page-side script's function, without the comments and type notes above it. */
export function pageFunction(file: string, name: string): string {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf("\n/**\n * @typedef", start);
  return source.slice(start, end === -1 ? undefined : end);
}

const SNAPSHOT = pageFunction("./page-snapshot.js", "pageSnapshot");
const ELEMENTS = pageFunction("./page-elements.js", "pageElements");

/** Something on a page a person can press or type into, numbered "E1", "E2"... */
export interface PageElement {
  ref: string;
  kind: string;
  label: string;
  /** Pressing it (or Enter in it) would send something, so it needs browser_submit. */
  submits: boolean;
}

export interface PageSnapshot {
  url: string;
  /** Which page it is (performance.timeOrigin): its E-references are good on it alone. */
  doc?: number;
  title: string;
  text: string;
  /** Link addresses; "L1" is links[0]. */
  links: string[];
  truncated: boolean;
  /** A selector was given and nothing on the page matched it. */
  missing: boolean;
  /** Numbered when asked for; empty otherwise. */
  elements: PageElement[];
}

/** A page-side function called with its options and the element helpers. */
export function pageCall(fn: string, opts: Record<string, unknown>): string {
  return `(${fn})(${JSON.stringify(opts)}, (${ELEMENTS})(${JSON.stringify(PAGE_RULES)}))`;
}

/** The page-side reader as an expression, for Runtime.evaluate (and tests in a real browser). */
export function snapshotExpression(maxChars: number, selector?: string, elements = false): string {
  return pageCall(SNAPSHOT, { maxChars, ...(selector ? { selector } : {}), elements });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long to wait for pages: before a navigation shows, between checks, and after a load. */
export const loadTiming = { startMs: 400, pollMs: 300, settleMs: 500 };

/** What a read says first when it caught the page still coming in (B1). */
export const STILL_LOADING = "The page is still loading; read it again in a moment.";

/**
 * A read's text, led by STILL_LOADING and marked `loading` when it caught the page still coming
 * in: Jarvis may be looking at part of the page, or none of it.
 */
export function loadingRead(text: string, loading: boolean) {
  if (!loading) return { text };
  return { loading: true as const, text: text ? `${STILL_LOADING}\n${text}` : STILL_LOADING };
}

/** The tabs Jarvis may use. */
export const listTabs = (client: BrowserClient) => client.call<TabInfo[]>("tabs.list");

export async function findTab(
  client: BrowserClient,
  tabId: number,
  tabs?: TabInfo[],
): Promise<TabInfo> {
  const tab = (tabs ?? (await listTabs(client))).find((t) => t.tabId === tabId);
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
    // A dialog stops the page where it is until it's answered.
    if (tab.dialog) return tab;
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
  elements = false,
): Promise<PageSnapshot> {
  return evaluate<PageSnapshot>(client, tabId, snapshotExpression(maxChars, selector, elements));
}

// The links and elements of the last page read in each tab. Kept in this process only, which is
// the one Jarvis runs in, so a reference is good until the tab is read again.
const MAX_PAGES = 50;
const pageLinks = new Map<number, { url: string; links: string[]; elements: PageElement[] }>();

export function rememberLinks(
  tabId: number,
  url: string,
  links: string[],
  elements: PageElement[] = [],
): void {
  pageLinks.delete(tabId);
  pageLinks.set(tabId, { url, links, elements });
  const oldest = pageLinks.keys().next().value;
  if (pageLinks.size > MAX_PAGES && oldest !== undefined) pageLinks.delete(oldest);
}

// The page each tab's E-references were numbered on, by browser_read. Kept apart from the links,
// which browser_read_page also keeps; going to another page forgets both.
const readDocs = new Map<number, number>();

export function rememberDoc(tabId: number, doc: number | undefined): void {
  readDocs.delete(tabId);
  if (doc !== undefined) readDocs.set(tabId, doc);
  const oldest = readDocs.keys().next().value;
  if (readDocs.size > MAX_PAGES && oldest !== undefined) readDocs.delete(oldest);
}

/** The page a tab's E-references belong to, if this process read it. */
export const readDoc = (tabId: number): number | undefined => readDocs.get(tabId);

/** The address behind "L4" on the page last read in a tab, or null. */
export function linkUrl(tabId: number, ref: string): string | null {
  const n = /^L(\d+)$/i.exec(ref.trim());
  if (!n) return null;
  return pageLinks.get(tabId)?.links[Number(n[1]) - 1] ?? null;
}

/** What "E4" was on the page last read in a tab, and that page's address, if known here. */
export function elementSeen(
  tabId: number,
  ref: string,
): { url: string; element: PageElement | null } | null {
  const page = pageLinks.get(tabId);
  if (!page) return null;
  return { url: page.url, element: page.elements.find((e) => e.ref === ref) ?? null };
}

export function forgetLinks(tabId: number): void {
  pageLinks.delete(tabId);
  readDocs.delete(tabId);
}
