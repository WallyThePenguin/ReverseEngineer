// The live view's link to your Chrome: the tabs Jarvis may use, and pictures of the one you're
// watching, over a WebSocket to Hearth's server, which relays to the Hearth extension.

import { createSignal } from "solid-js";

export interface BrowserTab {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  active: boolean;
  /** One of your tabs you handed to Jarvis. */
  handed: boolean;
  loading: boolean;
}

export interface Frame {
  tabId: number;
  data: string;
  /** The page's size in CSS pixels; clicks are scaled to it. */
  width: number;
  height: number;
}

export interface BrowserStatus {
  connected: boolean;
  paired: boolean;
  version: string | null;
  since: string | null;
  tabs: BrowserTab[];
  /** Hearth opens Chrome by itself when it's closed. */
  canOpen?: boolean;
  opening?: boolean;
  /** Why the last try to open Chrome failed. */
  openError?: string | null;
}

/** Whether Chrome is connected and paired. */
export async function browserStatus(): Promise<BrowserStatus> {
  const res = await fetch("/api/browser/status", { credentials: "same-origin" });
  if (!res.ok) throw new Error("Couldn't check Chrome's connection.");
  return (await res.json()) as BrowserStatus;
}

/** A new pairing code for the extension, shown once. Pairing again disconnects the old one. */
export async function pairBrowser(): Promise<string> {
  const res = await fetch("/api/browser/pair", { method: "POST", credentials: "same-origin" });
  const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!res.ok || !body.token) throw new Error(body.error ?? "Couldn't make a pairing code.");
  return body.token;
}

/** Opens Chrome on the PC now. Resolves once it's connected; throws saying why it isn't. */
export async function openChrome(): Promise<void> {
  const res = await fetch("/api/browser/open", { method: "POST", credentials: "same-origin" });
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? "Couldn't open Chrome.");
}

export async function unpairBrowser(): Promise<void> {
  await fetch("/api/browser/pair", { method: "DELETE", credentials: "same-origin" });
}

/** The tab to show first: Jarvis's tab in front, else any of its tabs, else one you handed it. */
export function defaultTab(tabs: BrowserTab[]): number | null {
  const own = tabs.filter((t) => !t.handed);
  return (own.find((t) => t.active) ?? own[0] ?? tabs[0])?.tabId ?? null;
}

/** CDP's modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function modifiers(e: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}) {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

/** Where a point on the picture lands on the page, in the page's CSS pixels. */
export function toPage(
  point: { x: number; y: number },
  shown: { left: number; top: number; width: number; height: number },
  frame: { width: number; height: number },
) {
  return {
    x: Math.round(((point.x - shown.left) * frame.width) / shown.width),
    y: Math.round(((point.y - shown.top) * frame.height) / shown.height),
  };
}

export function createLiveBrowser() {
  const [online, setOnline] = createSignal(false);
  const [connected, setConnected] = createSignal(false);
  const [tabs, setTabs] = createSignal<BrowserTab[]>([]);
  const [tabId, setTabId] = createSignal<number | null>(null);
  const [frame, setFrame] = createSignal<Frame | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [opener, setOpener] = createSignal({
    canOpen: false,
    opening: false,
    openError: null as string | null,
    paired: true,
  });
  let ws: WebSocket | null = null;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const send = (msg: Record<string, unknown>) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const view = (id: number) => {
    if (id !== tabId()) setFrame(null);
    setTabId(id);
    setError(null);
    send({ type: "view", tabId: id });
  };

  const onMessage = (msg: Record<string, unknown> & { type: string }) => {
    switch (msg.type) {
      case "state": {
        const list = msg.tabs as BrowserTab[];
        setConnected(Boolean(msg.connected));
        setOpener({
          canOpen: Boolean(msg.canOpen),
          opening: Boolean(msg.opening),
          openError: typeof msg.openError === "string" ? msg.openError : null,
          paired: msg.paired !== false,
        });
        setTabs(list);
        const current = tabId();
        if (current === null || !list.some((t) => t.tabId === current)) {
          const next = defaultTab(list);
          if (next === null) {
            setTabId(null);
            setFrame(null);
          } else view(next);
        }
        return;
      }
      case "watching":
        if (msg.tabId !== tabId()) setFrame(null);
        setTabId(msg.tabId as number);
        return;
      case "frame":
        if (msg.tabId === tabId()) setFrame(msg as unknown as Frame);
        return;
      case "error":
        setError(String(msg.message));
        return;
    }
  };

  const connect = () => {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${scheme}://${location.host}/api/browser/live`);
    ws.onopen = () => {
      setOnline(true);
      const current = tabId();
      if (current !== null) send({ type: "view", tabId: current });
    };
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(String(e.data)));
      } catch {
        // A broken message is skipped; the next frame replaces it.
      }
    };
    ws.onclose = () => {
      setOnline(false);
      if (!stopped) retry = setTimeout(connect, 2000);
    };
  };
  connect();

  return {
    online,
    connected,
    /** Whether Hearth can open Chrome, is opening it, and why it last couldn't. */
    opener,
    tabs,
    tabId,
    frame,
    error,
    send,
    view,
    current: () => tabs().find((t) => t.tabId === tabId()) ?? null,
    stop() {
      stopped = true;
      clearTimeout(retry);
      ws?.close();
    },
  };
}

export type LiveBrowser = ReturnType<typeof createLiveBrowser>;
