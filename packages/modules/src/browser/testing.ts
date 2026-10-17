// A pretend Chrome for tests: tabs and pages from a table, with every request recorded.
import { ActionError } from "@hearth/kernel";
import { dialogOpen } from "../../../../apps/extension/rules.js";
import {
  type BrowserClient,
  type BrowserStatus,
  chromeError,
  type DialogInfo,
  OFFLINE_MESSAGE,
  type TabInfo,
} from "./client.ts";
import { pacing } from "./pace.ts";
import { loadTiming, type PageSnapshot } from "./page.ts";

export interface FakePage {
  title: string;
  text: string;
  links?: string[];
  /** Chrome couldn't load it: the reason Page.navigate gives, like net::ERR_NAME_NOT_RESOLVED. */
  error?: string;
  /** Hearth's own page, by the mark in its head, whatever its address. */
  mark?: boolean;
}

/** Pages load at once in tests, and Jarvis doesn't pause between steps. */
export function instantLoads(): void {
  Object.assign(loadTiming, { startMs: 0, pollMs: 0, settleMs: 0 });
  pacing.enabled = false;
}

export class FakeBrowser implements BrowserClient {
  connected = true;
  /** When set, protocol commands fail with this message, as on a page that won't load. */
  cdpError: string | null = null;
  /** Answers the server's driver (driver.read_page, driver.click...), when a test sets it. */
  driver: ((op: string, params: Record<string, unknown>) => unknown) | null = null;
  tabs: TabInfo[] = [];
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  readonly pages: Record<string, FakePage>;
  private nextId = 1;
  /** Each tab's history: the addresses it went to, and where it is in them. */
  private readonly history = new Map<number, { urls: string[]; at: number }>();
  /** Pages loaded so far, each tab's page numbered by it (its performance.timeOrigin). */
  private loads = 0;
  private readonly docs = new Map<number, number>();

  constructor(pages: Record<string, FakePage> = {}) {
    this.pages = pages;
  }

  /** One of your own tabs, handed to Jarvis. */
  hand(url: string): TabInfo {
    return this.addTab(url, true);
  }

  async status(): Promise<BrowserStatus> {
    return { connected: this.connected, version: "test", since: null, tabs: this.tabs };
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    if (!this.connected) throw new ActionError("unavailable", OFFLINE_MESSAGE);
    return this.answer(method, params) as T;
  }

  /** A page in the tab opens a dialog, which holds everything else there until it's answered. */
  openDialog(tabId: number, dialog: DialogInfo): void {
    this.tab(tabId).dialog = dialog;
  }

  /** The CDP methods called, in order. */
  cdpMethods(): string[] {
    return this.calls.filter((c) => c.method === "cdp").map((c) => String(c.params.method));
  }

  private addTab(url: string, handed: boolean): TabInfo {
    const tab: TabInfo = {
      tabId: this.nextId++,
      windowId: handed ? 1 : 2,
      url,
      title: this.pages[url]?.title ?? "",
      active: true,
      handed,
      loading: false,
      dialog: null,
    };
    this.tabs.push(tab);
    this.history.set(tab.tabId, { urls: [url], at: 0 });
    this.docs.set(tab.tabId, ++this.loads);
    return tab;
  }

  private tab(tabId: unknown): TabInfo {
    const tab = this.tabs.find((t) => t.tabId === tabId);
    if (!tab) throw new Error("That tab isn't Pip's and wasn't handed to it.");
    return tab;
  }

  private answer(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case "tabs.list":
        return this.tabs;
      case "tabs.open":
        return this.addTab(String(params.url), false);
      case "tabs.close":
      case "tabs.release":
        this.tab(params.tabId);
        this.tabs = this.tabs.filter((t) => t.tabId !== params.tabId);
        return {};
      case "tabs.show":
        return {};
      case "cdp":
        return this.cdp(this.tab(params.tabId), String(params.method), params.params as never);
      default:
        if (method.startsWith("driver.") && this.driver)
          return this.driver(method.slice(7), params);
        throw new Error(`Unknown method ${method}`);
    }
  }

  private go(tab: TabInfo, url: string): void {
    tab.url = url;
    tab.title = this.pages[url]?.title ?? "";
    this.docs.set(tab.tabId, ++this.loads);
  }

  private cdp(tab: TabInfo, method: string, params: Record<string, unknown> = {}): unknown {
    if (this.cdpError) throw new Error(this.cdpError);
    if (tab.dialog && method !== "Page.handleJavaScriptDialog")
      throw chromeError(dialogOpen(tab.dialog).message, "dialog_open");
    const history = this.history.get(tab.tabId) ?? { urls: [tab.url], at: 0 };
    switch (method) {
      case "Page.navigate": {
        this.go(tab, String(params.url));
        history.urls = [...history.urls.slice(0, history.at + 1), tab.url];
        history.at = history.urls.length - 1;
        const error = this.pages[tab.url]?.error;
        return { frameId: "main", ...(error ? { errorText: error } : {}) };
      }
      case "Page.getNavigationHistory":
        return {
          currentIndex: history.at,
          entries: history.urls.map((url, id) => ({
            id,
            url,
            title: this.pages[url]?.title ?? "",
          })),
        };
      case "Page.navigateToHistoryEntry":
        history.at = Number(params.entryId);
        this.go(tab, history.urls[history.at] ?? tab.url);
        return {};
      case "Page.handleJavaScriptDialog":
        if (!tab.dialog)
          throw chromeError("There's no dialog open in this tab any more.", "no_dialog");
        tab.dialog = null;
        return {};
      case "Page.getLayoutMetrics":
        return {
          cssVisualViewport: { clientWidth: 1280, clientHeight: 800, pageX: 0, pageY: 0 },
          visualViewport: { clientWidth: 1600, clientHeight: 1000 },
          cssContentSize: { width: 1280, height: 3000 },
        };
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: "main" } } };
      case "Page.createIsolatedWorld":
        return { executionContextId: 7 };
      case "Runtime.evaluate": {
        const page = this.pages[tab.url] ?? { title: "", text: "" };
        // Where the page is, asked before Jarvis's hands do anything there.
        if (String(params.expression).includes("performance.timeOrigin")) {
          const here = { href: tab.url, doc: this.docs.get(tab.tabId), mark: Boolean(page.mark) };
          return { result: { type: "object", value: here } };
        }
        const max = Number(/"maxChars":(\d+)/.exec(String(params.expression))?.[1] ?? 1e9);
        const value: PageSnapshot = {
          url: tab.url,
          title: page.title,
          text: page.text.slice(0, max),
          links: page.links ?? [],
          truncated: page.text.length > max,
          missing: false,
          elements: [],
        };
        return { result: { type: "object", value } };
      }
      case "Page.captureScreenshot":
        return { data: "SlBFRw==" };
      default:
        return {};
    }
  }
}
