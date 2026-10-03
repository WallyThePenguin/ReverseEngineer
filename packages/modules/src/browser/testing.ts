// A pretend Chrome for tests: tabs and pages from a table, with every request recorded.
import { ActionError } from "@hearth/kernel";
import { type BrowserClient, type BrowserStatus, OFFLINE_MESSAGE, type TabInfo } from "./client.ts";
import { pacing } from "./pace.ts";
import { loadTiming, type PageSnapshot } from "./page.ts";

export interface FakePage {
  title: string;
  text: string;
  links?: string[];
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
  tabs: TabInfo[] = [];
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  readonly pages: Record<string, FakePage>;
  private nextId = 1;

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
    };
    this.tabs.push(tab);
    return tab;
  }

  private tab(tabId: unknown): TabInfo {
    const tab = this.tabs.find((t) => t.tabId === tabId);
    if (!tab) throw new Error("That tab isn't Jarvis's and wasn't handed to it.");
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
        throw new Error(`Unknown method ${method}`);
    }
  }

  private cdp(tab: TabInfo, method: string, params: Record<string, unknown> = {}): unknown {
    if (this.cdpError) throw new Error(this.cdpError);
    switch (method) {
      case "Page.navigate":
        tab.url = String(params.url);
        tab.title = this.pages[tab.url]?.title ?? "";
        return { frameId: "main" };
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: "main" } } };
      case "Page.createIsolatedWorld":
        return { executionContextId: 7 };
      case "Runtime.evaluate": {
        const page = this.pages[tab.url] ?? { title: "", text: "" };
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
