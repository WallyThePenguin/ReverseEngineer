// How Hearth reaches your Chrome (D24): the Hearth extension connects to the server, the server
// holds that connection, and every other process talks to it over HTTP through this interface.
import { createSession, type Db, session } from "@hearth/db";
import { ActionError, type ActionErrorCode } from "@hearth/kernel";
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
  /** The tab that opened it (a pop-up, or a link that opens in a new tab), if any. */
  openerTabId?: number | null;
  /** An alert, confirm, prompt or "leave site?" dialog waiting for an answer. */
  dialog?: DialogInfo | null;
  /** Why the last page the tab tried to load didn't, like net::ERR_NAME_NOT_RESOLVED. */
  error?: string | null;
}

/** A page's dialog. Its message is the page's own words, so it's outside content. */
export interface DialogInfo {
  type: string;
  message: string;
  url: string;
  defaultPrompt?: string;
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
  /** Whether an extension is paired, once the server knows. */
  paired?: boolean;
  /** The link's protocol the connected extension speaks (1 before it said). */
  protocol?: number | null;
  /** The connected extension's ID, and the one Hearth's own extension has. */
  extensionId?: string | null;
  expectedId?: string;
  /** Something wrong with the connected extension, in a sentence for the owner. */
  problem?: string | null;
}

/**
 * A failure Chrome reported with a reason Hearth acts on: "dialog_open" (a dialog is waiting),
 * "no_dialog" (the dialog to answer was already closed), "not_allowed" (a command Hearth may not
 * send) or "not_yours" (a tab Jarvis may not use).
 */
export class BrowserError extends ActionError {
  readonly reason: string;
  constructor(code: ActionErrorCode, message: string, reason: string) {
    super(code, message);
    this.reason = reason;
  }
}

/**
 * A failure the extension reported, as Hearth passes it on: with its reason when it has one
 * ("dialog_open" is a conflict to resolve, a refused command or tab is forbidden), otherwise as
 * Chrome's own words.
 */
export function chromeError(message: string, reason?: string | null): ActionError {
  if (!reason) return new ActionError("failed", `Chrome: ${message}`);
  const code: ActionErrorCode =
    reason === "dialog_open"
      ? "conflict"
      : reason === "no_dialog"
        ? "not_found"
        : reason === "not_allowed" || reason === "not_yours"
          ? "forbidden"
          : "failed";
  return new BrowserError(code, message, reason);
}

/** The reason on a browser failure, if it has one. */
export function reasonOf(err: unknown): string | null {
  return err instanceof BrowserError ? err.reason : null;
}

const CODES = new Set<string>([
  "unknown_action",
  "invalid_input",
  "not_found",
  "conflict",
  "forbidden",
  "unavailable",
  "failed",
]);

/** Rebuilds an error the bridge sent over HTTP, with its code and reason. */
export function bridgeError(
  body: { error?: string; code?: string; reason?: string },
  status: number,
) {
  const code = (
    CODES.has(body.code ?? "") ? body.code : status === 503 ? "unavailable" : "failed"
  ) as ActionErrorCode;
  const message =
    body.error ??
    (code === "unavailable" ? OFFLINE_MESSAGE : `The browser bridge answered ${status}.`);
  return body.reason
    ? new BrowserError(code, message, body.reason)
    : new ActionError(code, message);
}

/** One request to the extension: tabs.list, tabs.open, tabs.close, tabs.release, tabs.show, cdp. */
export interface BrowserClient {
  status(): Promise<BrowserStatus>;
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export const OFFLINE_MESSAGE =
  "Chrome isn't connected to Nook. Open Chrome on the PC; the Nook extension connects by itself.";

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
          throw new ActionError("failed", "Nook's server took too long to answer about Chrome.");
        throw new ActionError(
          "unavailable",
          "Nook's server isn't reachable, so neither is Chrome.",
        );
      }
      if (res.status === 401 && !fresh) continue;
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
        reason?: string;
      };
      if (res.ok) return body as T;
      throw bridgeError(body, res.status);
    }
    throw new ActionError("failed", "The browser bridge refused Nook's own token.");
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
