// The driver's way to Chrome (B1, D52): the extension's link (bridge.ts) in Hearth, or a Chromium
// the tests start (testing/chrome.ts). Either carries protocol commands for a tab, and for the
// frames from other sites inside it by their child sessions, and passes the page's events back.

/** A page event, with the frame session it came from when that's not the tab's own. */
export interface DriverEvent {
  tabId: number;
  sessionId?: string;
  method: string;
  params: Record<string, unknown>;
}

export interface CdpTransport {
  /** "cdp" {tabId, method, params, sessionId?}, "tabs.list", "tabs.show", "tabs.frames". */
  call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>;
  onEvent(listener: (e: DriverEvent) => void): () => void;
}

/** No single protocol command waits longer than this (B1: no call waits more than 10 s). */
export const COMMAND_MS = 10_000;

/** One tab's protocol commands, to the tab itself or to one of its frames' sessions. */
export class Cdp {
  readonly transport: CdpTransport;
  readonly tabId: number;

  constructor(transport: CdpTransport, tabId: number) {
    this.transport = transport;
    this.tabId = tabId;
  }

  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    session?: string,
    timeoutMs = COMMAND_MS,
  ): Promise<T> {
    return this.transport.call<T>(
      "cdp",
      { tabId: this.tabId, method, params, ...(session ? { sessionId: session } : {}) },
      timeoutMs,
    );
  }
}

/** Runs `fn` over `items`, at most `limit` at a time, keeping their order. */
export async function inParallel<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, n: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const n = next++;
      out[n] = await fn(items[n] as T, n);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
