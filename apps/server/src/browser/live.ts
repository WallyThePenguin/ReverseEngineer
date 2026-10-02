// The live view (D24): a tab streamed into Hearth as pictures, with your clicks, scrolls and keys
// sent back. Sites refuse to be framed inside another page, so this is how Hearth shows them.
// Everything here is you acting, so it goes straight to Chrome rather than through actions.
import type { BrowserStatus, TabInfo } from "@hearth/modules";
import type { WebSocket } from "ws";
import type { BrowserBridge, CdpEvent } from "./bridge.ts";
import { keyEvent } from "./keys.ts";

interface Cast {
  viewers: Set<WebSocket>;
  last: string | null;
  lastAt: number;
  poll: ReturnType<typeof setInterval>;
}

type ViewerMessage = {
  type: string;
  tabId?: number;
  url?: string;
  kind?: string;
  x?: number;
  y?: number;
  button?: string;
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  key?: string;
  code?: string;
  text?: string;
  modifiers?: number;
};

/** What the Browser pane shows: Chrome's connection, whether it's being opened, and the tabs. */
function state(s: BrowserStatus) {
  const { connected, canOpen, opening, openError, tabs } = s;
  return { type: "state", connected, canOpen, opening, openError, tabs };
}

function send(ws: WebSocket, msg: unknown): void {
  // A slow phone connection skips frames instead of piling them up.
  if (ws.readyState === ws.OPEN && ws.bufferedAmount < 4 * 1024 * 1024)
    ws.send(JSON.stringify(msg));
}

export class LiveView {
  private readonly bridge: BrowserBridge;
  private readonly casts = new Map<number, Cast>();
  private readonly watching = new Map<WebSocket, number>();
  private readonly viewers = new Set<WebSocket>();

  constructor(bridge: BrowserBridge) {
    this.bridge = bridge;
    bridge.onEvent((e) => this.onEvent(e));
    bridge.onState((s) => {
      for (const ws of this.viewers) send(ws, state(s));
    });
  }

  connect(ws: WebSocket): void {
    this.viewers.add(ws);
    send(ws, state(this.bridge.snapshot()));
    ws.on("message", (data) => {
      let msg: ViewerMessage;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      this.handle(ws, msg).catch((err: unknown) =>
        send(ws, { type: "error", message: err instanceof Error ? err.message : String(err) }),
      );
    });
    ws.on("close", () => {
      this.viewers.delete(ws);
      this.unwatch(ws);
    });
  }

  private cdp(tabId: number, method: string, params: Record<string, unknown> = {}) {
    return this.bridge.call<Record<string, unknown>>("cdp", { tabId, method, params });
  }

  private async handle(ws: WebSocket, msg: ViewerMessage): Promise<void> {
    if (msg.type === "view" && typeof msg.tabId === "number") return this.watch(ws, msg.tabId);
    if (msg.type === "open" && msg.url) {
      const tab = await this.bridge.call<TabInfo>("tabs.open", { url: msg.url });
      return this.watch(ws, tab.tabId);
    }
    const tabId = this.watching.get(ws);
    if (tabId === undefined) return;
    switch (msg.type) {
      case "navigate":
        if (msg.url) await this.cdp(tabId, "Page.navigate", { url: msg.url });
        return;
      case "reload":
        await this.cdp(tabId, "Page.reload");
        return;
      case "back":
      case "forward": {
        const h = (await this.cdp(tabId, "Page.getNavigationHistory")) as {
          currentIndex: number;
          entries: { id: number }[];
        };
        const entry = h.entries[h.currentIndex + (msg.type === "back" ? -1 : 1)];
        if (entry) await this.cdp(tabId, "Page.navigateToHistoryEntry", { entryId: entry.id });
        return;
      }
      case "close":
        await this.bridge.call("tabs.close", { tabId });
        return;
      case "mouse":
        await this.cdp(tabId, "Input.dispatchMouseEvent", {
          type: msg.kind,
          x: msg.x,
          y: msg.y,
          button: msg.button ?? "left",
          clickCount: msg.clickCount ?? 1,
          modifiers: msg.modifiers ?? 0,
        });
        return;
      case "wheel":
        await this.cdp(tabId, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: msg.x,
          y: msg.y,
          deltaX: msg.deltaX ?? 0,
          deltaY: msg.deltaY ?? 0,
        });
        return;
      case "key":
        await this.cdp(tabId, "Input.dispatchKeyEvent", keyEvent(msg));
        return;
      case "text":
        if (msg.text) await this.cdp(tabId, "Input.insertText", { text: msg.text });
        return;
    }
  }

  private async watch(ws: WebSocket, tabId: number): Promise<void> {
    this.unwatch(ws);
    this.watching.set(ws, tabId);
    send(ws, { type: "watching", tabId });
    let cast = this.casts.get(tabId);
    if (!cast) {
      cast = {
        viewers: new Set(),
        last: null,
        lastAt: 0,
        poll: setInterval(() => void this.fallbackFrame(tabId), 1000),
      };
      this.casts.set(tabId, cast);
      const status = await this.bridge.status();
      // Chrome only draws the tab showing in its window, so bring Jarvis's tab forward.
      if (status.tabs.find((t) => t.tabId === tabId && !t.handed))
        await this.bridge.call("tabs.show", { tabId });
      await this.cdp(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
      await this.cdp(tabId, "Page.startScreencast", {
        format: "jpeg",
        quality: 70,
        maxWidth: 1600,
        maxHeight: 1600,
      });
    }
    cast.viewers.add(ws);
    if (cast.last) send(ws, JSON.parse(cast.last));
  }

  private unwatch(ws: WebSocket): void {
    const tabId = this.watching.get(ws);
    this.watching.delete(ws);
    if (tabId === undefined) return;
    const cast = this.casts.get(tabId);
    if (!cast) return;
    cast.viewers.delete(ws);
    if (cast.viewers.size > 0) return;
    clearInterval(cast.poll);
    this.casts.delete(tabId);
    void this.cdp(tabId, "Page.stopScreencast").catch(() => {});
  }

  private broadcast(tabId: number, frame: Record<string, unknown>): void {
    const cast = this.casts.get(tabId);
    if (!cast) return;
    const msg = { type: "frame", tabId, ...frame };
    cast.last = JSON.stringify(msg);
    cast.lastAt = Date.now();
    for (const ws of cast.viewers) send(ws, msg);
  }

  /** When a window is covered, Chrome stops drawing it; a screenshot a second keeps the view alive. */
  private async fallbackFrame(tabId: number): Promise<void> {
    const cast = this.casts.get(tabId);
    if (!cast || Date.now() - cast.lastAt < 1500) return;
    cast.lastAt = Date.now();
    const shot = (await this.cdp(tabId, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 60,
    }).catch(() => null)) as { data?: string } | null;
    const metrics = (await this.cdp(tabId, "Page.getLayoutMetrics").catch(() => null)) as {
      cssVisualViewport?: { clientWidth: number; clientHeight: number };
    } | null;
    const viewport = metrics?.cssVisualViewport;
    if (!shot?.data || !viewport) return;
    this.broadcast(tabId, {
      data: shot.data,
      width: viewport.clientWidth,
      height: viewport.clientHeight,
    });
  }

  private onEvent(e: CdpEvent): void {
    if (e.method === "Page.screencastFrame") {
      const p = e.params as {
        data: string;
        sessionId: number;
        metadata: { deviceWidth: number; deviceHeight: number };
      };
      void this.cdp(e.tabId, "Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
      this.broadcast(e.tabId, {
        data: p.data,
        width: p.metadata.deviceWidth,
        height: p.metadata.deviceHeight,
      });
    }
    if (e.method === "Hearth.detached") {
      const cast = this.casts.get(e.tabId);
      if (!cast) return;
      for (const ws of cast.viewers) {
        send(ws, {
          type: "error",
          message: "Chrome stopped sharing that tab (the bar was closed).",
        });
        this.watching.delete(ws);
      }
      clearInterval(cast.poll);
      this.casts.delete(e.tabId);
    }
  }
}
