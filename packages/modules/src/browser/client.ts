// How Hearth reaches your Chrome (D24): the Hearth extension connects to the server, the server
// holds that connection, and every other process talks to it over HTTP through this interface.
import { createSession, type Db, session } from "@hearth/db";
import { ActionError } from "@hearth/kernel";
import { and, eq, lt } from "drizzle-orm";

/** The kernel service name actions use: ctx.service<BrowserClient>(BROWSER_SERVICE). */
export const BROWSER_SERVICE = "browser";

export interface TabInfo {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  /** Showing in its window. Chrome only draws visible tabs, so these stream best. */
  active: boolean;
  /** One of your tabs you handed to Jarvis, rather than one Jarvis opened. */
  handed: boolean;
  loading: boolean;
}

export interface BrowserStatus {
  connected: boolean;
  /** The extension's version, when connected. */
  version: string | null;
  /** When the extension connected. */
  since: string | null;
  tabs: TabInfo[];
  /** Whether Hearth opens Chrome by itself when it's closed (D28). */
  canOpen?: boolean;
  /** Chrome is being opened. */
  opening?: boolean;
  /** Why the last try to open Chrome failed, until it connects. */
  openError?: string | null;
}

/** One request to the extension: tabs.list, tabs.open, tabs.close, tabs.release, tabs.show, cdp. */
export interface BrowserClient {
  status(): Promise<BrowserStatus>;
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export const OFFLINE_MESSAGE =
  "Chrome isn't connected to Hearth. Open Chrome on the PC; the Hearth extension connects by itself.";

/** Long enough for the server to open Chrome and wait for it (D28), then do what was asked. */
export const REQUEST_TIMEOUT_MS = 150_000;

/** Reaches the server's browser bridge from Jarvis or the worker, with a short internal token. */
export class HttpBrowserClient implements BrowserClient {
  private readonly baseUrl: string;
  private readonly mintToken: () => Promise<string>;
  private token: string | null = null;
  private tokenAt = 0;

  constructor(baseUrl: string, mintToken: () => Promise<string>) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.mintToken = mintToken;
  }

  status(): Promise<BrowserStatus> {
    return this.request<BrowserStatus>("GET", "/api/browser/status");
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const body = await this.request<{ result: T }>("POST", "/api/browser/rpc", { method, params });
    return body.result;
  }

  private async bearer(fresh: boolean): Promise<string> {
    // Internal tokens last a day; a new one every 12 hours keeps a margin.
    if (fresh || !this.token || Date.now() - this.tokenAt > 12 * 3_600_000) {
      this.token = await this.mintToken();
      this.tokenAt = Date.now();
    }
    return this.token;
  }

  private async request<T>(method: string, path: string, json?: unknown): Promise<T> {
    for (const fresh of [false, true]) {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${await this.bearer(fresh)}`,
            ...(json ? { "content-type": "application/json" } : {}),
          },
          ...(json ? { body: JSON.stringify(json) } : {}),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        if ((err as Error).name === "TimeoutError")
          throw new ActionError("failed", "Hearth's server took too long to answer about Chrome.");
        throw new ActionError(
          "unavailable",
          "Hearth's server isn't reachable, so neither is Chrome.",
        );
      }
      if (res.status === 401 && !fresh) continue;
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) return body as T;
      if (res.status === 503) throw new ActionError("unavailable", body.error ?? OFFLINE_MESSAGE);
      throw new ActionError("failed", body.error ?? `The browser bridge answered ${res.status}.`);
    }
    throw new ActionError("failed", "The browser bridge refused Hearth's own token.");
  }
}

const INTERNAL_LABEL = "browser (internal)";

/** Where Jarvis and the worker find the server: HEARTH_SERVER_URL, or the port it listens on. */
export function serverUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HEARTH_SERVER_URL) return env.HEARTH_SERVER_URL;
  const host = env.HEARTH_HOST;
  const local = !host || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${local.includes(":") ? `[${local}]` : local}:${env.HEARTH_PORT ?? 4400}`;
}

/** Chrome as Jarvis or the worker sees it: through the server, signed in as `principal`. */
export function internalBrowserClient(db: Db, principal: string, baseUrl = serverUrl()) {
  return new HttpBrowserClient(baseUrl, async () => {
    // Day-long tokens, one every 12 hours per process: clear the spent ones as new ones are made.
    await db
      .delete(session)
      .where(
        and(
          eq(session.principal, principal),
          eq(session.label, INTERNAL_LABEL),
          lt(session.expiresAt, new Date()),
        ),
      );
    return createSession(db, { principal, kind: "api", label: INTERNAL_LABEL, ttlDays: 1 });
  });
}
