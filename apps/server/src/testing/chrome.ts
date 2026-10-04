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

interface Tab {
  id: number;
  targetId: string;
  session: string;
  handed: boolean;
  openerTabId: number | null;
  url: string;
  title: string;
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
    return chrome;
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

  /** Opens a page as one of Jarvis's tabs (or one you handed it), and waits for it to load. */
  async open(url: string, handed = false): Promise<number> {
    const { targetId } = await this.conn.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
    });
    const tab = await this.adopt(targetId, handed, null);
    await this.call("cdp", { tabId: tab.id, method: "Page.navigate", params: { url } });
    await this.loaded(tab.id);
    return tab.id;
  }

  /** Waits until the tab's page has loaded. */
  async loaded(tabId: number): Promise<void> {
    const tab = this.tab(tabId);
    for (let n = 0; n < 100; n++) {
      const r = await this.conn.send<{ result: { value: string } }>(
        "Runtime.evaluate",
        { expression: "document.readyState", returnByValue: true },
        tab.session,
      );
      if (r.result.value === "complete") return;
      await new Promise((res) => setTimeout(res, 50));
    }
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
    if (!tab)
      throw new HearthError("not_yours", "That tab isn't Jarvis's and wasn't handed to it.");
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
      loading: false,
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
