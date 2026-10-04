// A real Chromium behind the same interface as your Chrome, for tests: pages come from a table
// of HTML, and protocol commands go to the page through Playwright's CDP sessions, so the
// browser's hands are tested against a real page without the extension. It keeps the
// extension's rules (apps/extension/rules.js, D52): only allowed commands, scripts only in
// Hearth's isolated worlds, only Jarvis's own tabs and the ones handed to it, dialogs that stop
// a tab until they're answered, and pop-ups adopted from the tab that opened them.
import { existsSync } from "node:fs";
import { type Browser, type CDPSession, chromium, type Page } from "playwright";
import {
  answersItself,
  checkCommand,
  Dialogs,
  HearthError,
  NAVIGATIONS,
} from "../../../../apps/extension/rules.js";
import { type BrowserClient, type BrowserStatus, chromeError, type TabInfo } from "./client.ts";
import { BRIDGE_PROTOCOL, EXTENSION_ID } from "./protocol.ts";

/** Where a Chromium is, if one is installed (HEARTH_E2E_CHROME overrides). */
export function chromiumPath(): string | null {
  const path = process.env.HEARTH_E2E_CHROME ?? chromium.executablePath();
  return existsSync(path) ? path : null;
}

/**
 * Whether the browser tests can run. A missing Chromium fails the run rather than skipping in
 * silence, unless HEARTH_SKIP_BROWSER_TESTS=1 says to skip them.
 */
export function chromiumForTests(): boolean {
  if (chromiumPath()) return true;
  if (process.env.HEARTH_SKIP_BROWSER_TESTS === "1") return false;
  throw new Error(
    "No Chromium for the browser tests. Run `pnpm --filter @hearth/web exec playwright install chromium`, point HEARTH_E2E_CHROME at one, or set HEARTH_SKIP_BROWSER_TESTS=1 to skip them.",
  );
}

interface Tab {
  id: number;
  /** A navigation of the main frame has started and its page hasn't loaded yet. */
  loading: boolean;
  page: Page;
  cdp: CDPSession;
  handed: boolean;
  openerTabId: number | null;
  /** Isolated worlds made in this tab; scripts may run only there. */
  worlds: Set<unknown>;
  /** Navigations under way, during which "leave site?" answers itself in Jarvis's own tabs. */
  navigating: number;
}

export class ChromiumBrowser implements BrowserClient {
  readonly sites: Record<string, string>;
  /** Every protocol command, in order: method and params (tests look for secrets here too). */
  readonly sent: { method: string; params: Record<string, unknown> }[] = [];
  /** Form posts the pages made: url and body. */
  readonly posts: { url: string; body: string }[] = [];
  readonly dialogs = new Dialogs();
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
    return {
      connected: true,
      version: "chromium",
      since: null,
      tabs: await this.list(),
      protocol: BRIDGE_PROTOCOL,
      extensionId: EXTENSION_ID,
      expectedId: EXTENSION_ID,
    };
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    try {
      return await this.run<T>(method, params);
    } catch (err) {
      // As the bridge passes the extension's failures on: with their reason.
      if (err instanceof HearthError) throw chromeError(err.message, err.code);
      throw err;
    }
  }

  private async run<T>(method: string, params: Record<string, unknown>): Promise<T> {
    switch (method) {
      case "tabs.list":
        return (await this.list()) as T;
      case "tabs.open":
        return (await this.open(String(params.url), false)) as T;
      case "tabs.close": {
        const tab = this.tab(params.tabId);
        if (tab.handed) throw new HearthError("not_yours", "Jarvis can only close tabs it opened.");
        this.forget(tab);
        await tab.page.close();
        return {} as T;
      }
      case "tabs.release":
        // Your tab stays open; Jarvis just lets go of it.
        this.forget(this.tab(params.tabId));
        return {} as T;
      case "tabs.show":
        if (this.tab(params.tabId).handed)
          throw new HearthError("not_yours", "Only Jarvis's own tabs can be switched to.");
        return {} as T;
      case "cdp":
        return (await this.cdp(params)) as T;
      default:
        throw new HearthError("not_allowed", `Unknown request ${method}`);
    }
  }

  private async cdp(params: Record<string, unknown>): Promise<unknown> {
    const method = String(params.method);
    const p = (params.params ?? {}) as Record<string, unknown>;
    const tab = this.tab(params.tabId);
    checkCommand(method, p, tab.worlds);
    this.sent.push({ method, params: p });
    const nav = NAVIGATIONS.has(method);
    if (nav) tab.navigating++;
    try {
      const result = await this.dialogs.guard(tab.id, method, () =>
        // biome-ignore lint/suspicious/noExplicitAny: commands are checked against the allowlist.
        tab.cdp.send(method as any, p as any),
      );
      if (method === "Page.createIsolatedWorld")
        tab.worlds.add((result as { executionContextId: number }).executionContextId);
      if (method === "Page.handleJavaScriptDialog") this.dialogs.closed(tab.id);
      return result;
    } finally {
      if (nav) tab.navigating--;
    }
  }

  private tab(tabId: unknown): Tab {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab)
      throw new HearthError("not_yours", "That tab isn't Jarvis's and wasn't handed to it.");
    return tab;
  }

  private forget(tab: Tab): void {
    this.tabs.splice(this.tabs.indexOf(tab), 1);
    this.dialogs.closed(tab.id);
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
        openerTabId: t.openerTabId,
        dialog: this.dialogs.get(t.id),
        error: null,
      })),
    );
  }

  /** Serves the table's pages to every tab in a context, pop-ups included. */
  private async serve(page: Page): Promise<void> {
    await page.context().route("**/*", async (route) => {
      const req = route.request();
      const key = req.url().split("?")[0]!;
      if (req.method() === "POST") this.posts.push({ url: req.url(), body: req.postData() ?? "" });
      const html = this.sites[key];
      if (html === undefined) return route.fulfill({ status: 404, body: "Not found" });
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
    });
  }

  private async track(page: Page, handed: boolean, openerTabId: number | null): Promise<Tab> {
    const tab: Tab = {
      id: this.nextId++,
      loading: false,
      page,
      cdp: await page.context().newCDPSession(page),
      handed,
      openerTabId,
      worlds: new Set(),
      navigating: 0,
    };
    page.on("request", (r) => {
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) tab.loading = true;
    });
    page.on("load", () => {
      tab.loading = false;
    });
    // Playwright answers dialogs by itself unless someone listens; Hearth answers them instead.
    page.on("dialog", () => {});
    tab.cdp.on("Page.javascriptDialogOpening", (e) => {
      const dialog = {
        type: e.type,
        message: e.message,
        url: e.url,
        defaultPrompt: e.defaultPrompt,
      };
      if (answersItself(dialog, { navigating: tab.navigating > 0, own: !tab.handed }))
        void tab.cdp.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
      else this.dialogs.opened(tab.id, dialog);
    });
    tab.cdp.on("Page.javascriptDialogClosed", () => this.dialogs.closed(tab.id));
    // What the extension does when it attaches, so dialogs are reported.
    await tab.cdp.send("Page.enable");
    // A pop-up from one of Jarvis's tabs is Jarvis's; from one you handed it, it's handed.
    page.on("popup", (popup) => {
      if (this.tabs.includes(tab))
        void this.track(popup, tab.handed, tab.id).then((t) => this.tabs.push(t));
    });
    return tab;
  }

  private async open(url: string, handed: boolean): Promise<TabInfo> {
    const page = await this.browser.newPage();
    await this.serve(page);
    const tab = await this.track(page, handed, null);
    this.tabs.push(tab);
    await page.goto(url);
    return (await this.list()).find((t) => t.tabId === tab.id)!;
  }
}
