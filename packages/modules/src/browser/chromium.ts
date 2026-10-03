// A real Chromium behind the same interface as your Chrome, for tests: pages come from a table
// of HTML, and protocol commands go to the page through Playwright's CDP sessions, so the
// browser's hands are tested against a real page without the extension.
import { existsSync } from "node:fs";
import { ActionError } from "@hearth/kernel";
import { type Browser, type CDPSession, chromium, type Page } from "playwright";
import type { BrowserClient, BrowserStatus, TabInfo } from "./client.ts";

/** Where a Chromium is, if one is installed (HEARTH_E2E_CHROME overrides). */
export function chromiumPath(): string | null {
  const path = process.env.HEARTH_E2E_CHROME ?? chromium.executablePath();
  return existsSync(path) ? path : null;
}

interface Tab {
  id: number;
  /** A navigation of the main frame has started and its page hasn't loaded yet. */
  loading: boolean;
  page: Page;
  cdp: CDPSession;
  handed: boolean;
}

export class ChromiumBrowser implements BrowserClient {
  readonly sites: Record<string, string>;
  /** Every protocol command, in order: method and params (tests look for secrets here too). */
  readonly sent: { method: string; params: Record<string, unknown> }[] = [];
  /** Form posts the pages made: url and body. */
  readonly posts: { url: string; body: string }[] = [];
  private readonly browser: Browser;
  private readonly tabs: Tab[] = [];
  private nextId = 1;

  private constructor(browser: Browser, sites: Record<string, string>) {
    this.browser = browser;
    this.sites = sites;
  }

  /** Pages by address. A POST to an address is answered with that address's page too. */
  static async launch(sites: Record<string, string>): Promise<ChromiumBrowser> {
    const path = chromiumPath();
    if (!path) throw new Error("No Chromium installed");
    return new ChromiumBrowser(await chromium.launch({ executablePath: path }), sites);
  }

  close(): Promise<void> {
    return this.browser.close();
  }

  /** The page in a tab, for tests to look at directly. */
  page(tabId: number): Page {
    return this.tab(tabId).page;
  }

  async hand(url: string): Promise<number> {
    return (await this.open(url, true)).tabId;
  }

  async status(): Promise<BrowserStatus> {
    return { connected: true, version: "chromium", since: null, tabs: await this.list() };
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    switch (method) {
      case "tabs.list":
        return (await this.list()) as T;
      case "tabs.open":
        return (await this.open(String(params.url), false)) as T;
      case "tabs.close":
      case "tabs.release": {
        const tab = this.tab(params.tabId);
        this.tabs.splice(this.tabs.indexOf(tab), 1);
        await tab.page.close();
        return {} as T;
      }
      case "tabs.show":
        return {} as T;
      case "cdp": {
        const tab = this.tab(params.tabId);
        const p = (params.params ?? {}) as Record<string, unknown>;
        this.sent.push({ method: String(params.method), params: p });
        // biome-ignore lint/suspicious/noExplicitAny: CDP methods are checked by Chromium.
        return (await tab.cdp.send(params.method as any, p as any)) as T;
      }
      default:
        throw new ActionError("invalid_input", `Unknown method ${method}`);
    }
  }

  private tab(tabId: unknown): Tab {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) throw new ActionError("not_found", "No such tab");
    return tab;
  }

  private async list(): Promise<TabInfo[]> {
    return Promise.all(
      this.tabs.map(async (t) => ({
        tabId: t.id,
        windowId: t.handed ? 1 : 2,
        url: t.page.url(),
        title: await t.page.title().catch(() => ""),
        active: true,
        handed: t.handed,
        loading: t.loading,
      })),
    );
  }

  private async open(url: string, handed: boolean): Promise<TabInfo> {
    const page = await this.browser.newPage();
    await page.route("**/*", async (route) => {
      const req = route.request();
      const key = req.url().split("?")[0]!;
      if (req.method() === "POST") this.posts.push({ url: req.url(), body: req.postData() ?? "" });
      const html = this.sites[key];
      if (html === undefined) return route.fulfill({ status: 404, body: "Not found" });
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
    });
    const tab: Tab = {
      id: this.nextId++,
      loading: false,
      page,
      cdp: await page.context().newCDPSession(page),
      handed,
    };
    page.on("request", (r) => {
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) tab.loading = true;
    });
    page.on("load", () => {
      tab.loading = false;
    });
    this.tabs.push(tab);
    await page.goto(url);
    return (await this.list()).find((t) => t.tabId === tab.id)!;
  }
}
