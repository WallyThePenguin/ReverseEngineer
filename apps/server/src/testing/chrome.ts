// A Chromium that behaves like your Chrome with the Hearth extension, for the driver's tests: the
// extension's rules (apps/extension/rules.js) on every command, its setup on each tab and each
// frame from another site, dialogs that stop a tab until answered, and pop-ups adopted from the
// tab that opened them. It's a BrowserClient too, with the server's driver behind driver.*, so
// the browser module's actions can be tested against it end to end.

import { type BrowserClient, type BrowserStatus, chromeError, type TabInfo } from "@hearth/modules";
import {
  answersItself,
  CHILD_SETUP,
  checkCommand,
  Dialogs,
  HearthError,
  QUIET_EVENTS,
  SESSION_SETUP,
} from "../../../extension/rules.js";
import { Driver } from "../browser/driver/driver.ts";
import type { CdpTransport, DriverEvent } from "../browser/driver/transport.ts";
import { CdpConnection, type CdpMessage, FixtureServer, type Site } from "./cdp-connection.ts";

/**
 * How long open waits for a page to load (browser.open waits up to 20 s on Chrome's word that the
 * tab is loading): inside a test's 20 s, with Chromium's slow first page out of the way (WARM_MS).
 */
const LOAD_MS = 15_000;

/**
 * How long a new Chromium gets to load a first page, before any test opens one. On the Windows CI
 * runner the first page after launch went wrong where later ones took 0.1 to 0.4 s: its test spent
 * 7 to 12 s in open and then read an empty page. useChrome's hook allows for this, on top of
 * Chromium's own start.
 */
export const WARM_MS = 60_000;

interface Tab {
  id: number;
  targetId: string;
  session: string;
  handed: boolean;
  openerTabId: number | null;
  url: string;
  title: string;
  /** As the extension's tab list has it: from a navigation's start till its page has loaded. */
  loading: boolean;
  /** Child sessions (frames from other sites) and the frame each is for. */
  children: Map<string, string>;
  /** Isolated worlds made, per session ("" for the tab's own). */
  worlds: Map<string, Set<unknown>>;
}

export class TestChrome implements BrowserClient, CdpTransport {
  readonly server: FixtureServer;
  readonly driver: Driver;
  /** Every command sent, in order (tests look for things that shouldn't be there). */
  readonly sent: { method: string; params: Record<string, unknown> }[] = [];
  readonly dialogs = new Dialogs();
  private readonly conn: CdpConnection;
  private readonly tabs: Tab[] = [];
  private readonly listeners = new Set<(e: DriverEvent) => void>();
  private nextId = 1;

  private constructor(conn: CdpConnection, server: FixtureServer) {
    this.conn = conn;
    this.server = server;
    conn.on((m) => this.receive(m));
    this.driver = new Driver(this);
  }

  static async launch(executable: string, site: Site): Promise<TestChrome> {
    const server = new FixtureServer(site);
    await server.start();
    const conn = await CdpConnection.launch(executable);
    const chrome = new TestChrome(conn, server);
    await conn.send("Target.setDiscoverTargets", { discover: true });
    await chrome.warmUp().catch(async (err) => {
      await chrome.close();
      throw err;
    });
    return chrome;
  }

  /**
   * Loads a first page and closes it again, so no test starts on Chromium's first page. One that
   * doesn't load, slow or dropped, is tried again in a new tab till WARM_MS has gone, and then
   * the launch fails, saying what the last try found.
   */
  private async warmUp(): Promise<void> {
    const until = Date.now() + WARM_MS;
    let failed: unknown = "there was no time";
    for (;;) {
      const left = Math.min(LOAD_MS, Math.floor((until - Date.now()) / 1000) * 1000);
      if (left < 1000) break;
      failed = await this.open(this.url("a.test", "/"), false, left).then(
        () => null,
        (err) => err ?? "it failed",
      );
      if (!failed) break;
      await new Promise((res) => setTimeout(res, 500));
    }
    // Every tab it opened goes, loaded or not.
    for (const tab of [...this.tabs])
      await this.call("tabs.close", { tabId: tab.id }).catch(() => {});
    if (failed)
      throw new Error(
        `Chromium's first page didn't load: ${failed instanceof Error ? failed.message : failed}`,
      );
  }

  url(host: string, path = "/"): string {
    return this.server.url(host, path);
  }

  async close(): Promise<void> {
    await this.conn.close();
    await this.server.close();
  }

  async status(): Promise<BrowserStatus> {
    return { connected: true, version: "test", since: null, tabs: this.list() };
  }

  onEvent(listener: (e: DriverEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Opens a page as one of Jarvis's tabs (or one you handed it), and waits for it to load, as
   * browser.open does before Jarvis reads it. A page that doesn't load fails here, by name, rather
   * than as an empty read later on.
   */
  async open(url: string, handed = false, loadMs = LOAD_MS): Promise<number> {
    const { targetId } = await this.conn.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
    });
    const tab = await this.adopt(targetId, handed, null);
    // The wait starts before Page.navigate, which answers only once the page's response is in.
    const until = Date.now() + loadMs;
    const nav = await this.call<{ errorText?: string }>(
      "cdp",
      { tabId: tab.id, method: "Page.navigate", params: { url } },
      Math.max(100, loadMs),
    ).catch((err) => {
      // No answer in the time there was: loaded says where the tab got to.
      if (!/didn't answer/.test(String(err))) throw err;
      return null;
    });
    if (nav?.errorText) throw new Error(`${url} didn't load: ${nav.errorText}`);
    await this.loaded(tab.id, url, until, loadMs);
    return tab.id;
  }

  /**
   * Waits until the tab's page has loaded, not the blank page a new tab starts on. Page.navigate
   * answers once the response is in, before the new page replaces the blank one, and Chrome holds
   * the tab's other commands till it has; so each check gets only the time that's left.
   */
  private async loaded(tabId: number, url: string, until: number, ms: number): Promise<void> {
    const tab = this.tab(tabId);
    let state = "blank";
    for (;;) {
      const r = await this.conn
        .send<{ result: { value?: string } }>(
          "Runtime.evaluate",
          {
            expression: `location.href === "about:blank" ? "blank" : document.readyState`,
            returnByValue: true,
          },
          tab.session,
          Math.max(100, until - Date.now()),
        )
        // Held past the wait, or the page's context went as the new one came.
        .catch(() => ({ result: { value: undefined } }));
      state = r.result.value ?? state;
      if (state === "complete") return;
      if (Date.now() >= until) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error(`${url} didn't load in ${ms / 1000} s: it's still "${state}".`);
  }

  /** Runs an expression in the page's own world: for tests to look, never for the driver. */
  async peek<T>(tabId: number, expression: string): Promise<T> {
    const r = await this.conn.send<{ result: { value: T } }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      this.tab(tabId).session,
    );
    return r.result.value;
  }

  async call<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    try {
      return await this.run<T>(method, params, timeoutMs);
    } catch (err) {
      // As the bridge passes the extension's failures on: with their reason.
      if (err instanceof HearthError) throw chromeError(err.message, err.code);
      throw err;
    }
  }

  private async run<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    if (method.startsWith("driver.")) return (await this.driver.run(method.slice(7), params)) as T;
    switch (method) {
      case "tabs.list":
        return this.list() as T;
      case "tabs.open": {
        const tabId = await this.open(String(params.url));
        return this.list().find((t) => t.tabId === tabId) as T;
      }
      case "tabs.show":
        await this.conn.send("Target.activateTarget", {
          targetId: this.tab(params.tabId).targetId,
        });
        return { shown: true } as T;
      case "tabs.close": {
        const tab = this.tab(params.tabId);
        this.tabs.splice(this.tabs.indexOf(tab), 1);
        await this.conn.send("Target.closeTarget", { targetId: tab.targetId });
        return { closed: true } as T;
      }
      case "tabs.frames":
        return [...this.tab(params.tabId).children].map(([sessionId, targetId]) => ({
          sessionId,
          targetId,
        })) as T;
      case "cdp":
        return (await this.cdp(params, timeoutMs)) as T;
      default:
        throw new HearthError("not_allowed", `Unknown request ${method}`);
    }
  }

  private async cdp(params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const tab = this.tab(params.tabId);
    const method = String(params.method);
    const p = (params.params ?? {}) as Record<string, unknown>;
    const child = typeof params.sessionId === "string" ? params.sessionId : undefined;
    if (child !== undefined && !tab.children.has(child))
      throw new HearthError("gone", "That frame isn't on the page any more.");
    const key = child ?? "";
    checkCommand(method, p, tab.worlds.get(key));
    this.sent.push({ method, params: p });
    const result = await this.dialogs.guard(tab.id, method, () =>
      this.conn.send(method, p, child ?? tab.session, timeoutMs),
    );
    if (method === "Page.createIsolatedWorld") {
      const set = tab.worlds.get(key) ?? new Set();
      set.add((result as { executionContextId: number }).executionContextId);
      tab.worlds.set(key, set);
    }
    if (method === "Page.handleJavaScriptDialog") this.dialogs.closed(tab.id);
    return result;
  }

  private tab(tabId: unknown): Tab {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) throw new HearthError("not_yours", "That tab isn't Pip's and wasn't handed to it.");
    return tab;
  }

  private list(): TabInfo[] {
    return this.tabs.map((t) => ({
      tabId: t.id,
      windowId: 1,
      url: t.url,
      title: t.title,
      active: true,
      handed: t.handed,
      loading: t.loading,
      openerTabId: t.openerTabId,
      dialog: this.dialogs.get(t.id),
      error: null,
    }));
  }

  /** Attaches to a page as the extension would, and turns on what the driver relies on. */
  private async adopt(targetId: string, handed: boolean, opener: number | null): Promise<Tab> {
    // Listed at once, as the extension lists a pop-up as soon as Chrome says it opened.
    const tab: Tab = {
      id: this.nextId++,
      targetId,
      session: "",
      handed,
      openerTabId: opener,
      url: "",
      title: "",
      loading: false,
      children: new Map(),
      worlds: new Map(),
    };
    this.tabs.push(tab);
    const { sessionId } = await this.conn.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    tab.session = sessionId;
    for (const [m, p] of SESSION_SETUP) await this.conn.send(m, p, sessionId).catch(() => {});
    return tab;
  }

  private receive(m: CdpMessage): void {
    const params = m.params ?? {};
    if (!m.sessionId) {
      if (m.method === "Target.targetInfoChanged" || m.method === "Target.targetCreated") {
        const info = params.targetInfo as {
          targetId: string;
          type: string;
          url: string;
          title: string;
          openerId?: string;
        };
        const tab = this.tabs.find((t) => t.targetId === info.targetId);
        if (tab) {
          tab.url = info.url;
          tab.title = info.title;
        }
        const known = this.tabs.some((t) => t.targetId === info.targetId);
        // A pop-up from one of Jarvis's tabs is Jarvis's too.
        const opener = this.tabs.find((t) => t.targetId === info.openerId);
        if (m.method === "Target.targetCreated" && info.type === "page" && opener && !known)
          void this.adopt(info.targetId, opener.handed, opener.id);
      }
      return;
    }
    const tab = this.tabs.find(
      (t) => t.session === m.sessionId || t.children.has(m.sessionId ?? ""),
    );
    if (!tab || !m.method) return;
    const child = tab.session === m.sessionId ? undefined : m.sessionId;
    // The tab's own frame has the target's id.
    if (!child && params.frameId === tab.targetId) {
      if (m.method === "Page.frameStartedLoading") tab.loading = true;
      if (m.method === "Page.frameStoppedLoading") tab.loading = false;
    }
    if (m.method === "Target.attachedToTarget") {
      const sid = String(params.sessionId);
      tab.children.set(sid, (params.targetInfo as { targetId: string }).targetId);
      void (async () => {
        for (const [method, p] of CHILD_SETUP) await this.conn.send(method, p, sid).catch(() => {});
      })();
    }
    if (m.method === "Target.detachedFromTarget") {
      tab.children.delete(String(params.sessionId));
      tab.worlds.delete(String(params.sessionId));
    }
    if (m.method === "Page.javascriptDialogOpening") {
      const dialog = {
        type: String(params.type),
        message: String(params.message),
        url: String(params.url),
      };
      if (answersItself(dialog, { navigating: false, own: !tab.handed }))
        void this.conn
          .send("Page.handleJavaScriptDialog", { accept: true }, m.sessionId)
          .catch(() => {});
      else this.dialogs.opened(tab.id, dialog);
    }
    if (m.method === "Page.javascriptDialogClosed") this.dialogs.closed(tab.id);
    if (QUIET_EVENTS.has(m.method)) return;
    const event = {
      tabId: tab.id,
      ...(child ? { sessionId: child } : {}),
      method: m.method,
      params,
    };
    for (const l of this.listeners) l(event);
  }
}
