// The server's end of the Hearth extension (D24): one WebSocket from your Chrome, requests out,
// results and page events back. Jarvis, the worker and the live view all go through here.
import { ActionError } from "@hearth/kernel";
import {
  type BrowserClient,
  type BrowserStatus,
  OFFLINE_MESSAGE,
  type TabInfo,
} from "@hearth/modules";
import type { WebSocket } from "ws";

export interface CdpEvent {
  tabId: number;
  method: string;
  params: Record<string, unknown>;
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class BrowserBridge implements BrowserClient {
  private socket: WebSocket | null = null;
  private version: string | null = null;
  private since: Date | null = null;
  private tabs: TabInfo[] = [];
  private nextId = 1;
  private ping: ReturnType<typeof setInterval> | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly eventListeners = new Set<(e: CdpEvent) => void>();
  private readonly tabListeners = new Set<(tabs: TabInfo[], connected: boolean) => void>();

  /** A paired extension connected. It replaces any earlier connection (Chrome restarted). */
  adopt(ws: WebSocket, version: string): void {
    if (this.socket && this.socket !== ws)
      this.socket.close(4000, "Replaced by a newer connection");
    this.socket = ws;
    this.version = version;
    this.since = new Date();
    ws.on("message", (data) => this.receive(String(data)));
    ws.on("close", () => {
      if (this.socket === ws) this.drop();
    });
    // Keeps the extension's service worker awake while connected.
    if (this.ping) clearInterval(this.ping);
    this.ping = setInterval(() => ws.send(JSON.stringify({ type: "ping" })), 20_000);
    ws.send(JSON.stringify({ type: "welcome" }));
    this.notifyTabs();
  }

  async status(): Promise<BrowserStatus> {
    return {
      connected: this.socket !== null,
      version: this.version,
      since: this.since?.toISOString() ?? null,
      tabs: this.tabs,
    };
  }

  call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 45_000,
  ): Promise<T> {
    const ws = this.socket;
    if (!ws) return Promise.reject(new ActionError("unavailable", OFFLINE_MESSAGE));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ActionError("failed", `Chrome didn't answer (${method}) in time.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ type: "call", id, method, params }));
    });
  }

  /** Page events from Chrome (screencast frames, loads). Returns an unsubscribe. */
  onEvent(listener: (e: CdpEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Jarvis's tabs whenever they change, and whether Chrome is connected. */
  onTabs(listener: (tabs: TabInfo[], connected: boolean) => void): () => void {
    this.tabListeners.add(listener);
    return () => this.tabListeners.delete(listener);
  }

  close(): void {
    this.socket?.close(1001, "Hearth is stopping");
    this.drop();
  }

  private receive(raw: string): void {
    let msg: {
      type?: string;
      id?: number;
      result?: unknown;
      error?: string;
      tabId?: number;
      method?: string;
      params?: Record<string, unknown>;
      tabs?: TabInfo[];
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "result" && typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new ActionError("failed", `Chrome: ${msg.error}`));
      else p.resolve(msg.result);
    } else if (msg.type === "event" && typeof msg.tabId === "number" && msg.method) {
      const event = { tabId: msg.tabId, method: msg.method, params: msg.params ?? {} };
      for (const listener of this.eventListeners) listener(event);
    } else if (msg.type === "detached" && typeof msg.tabId === "number") {
      for (const listener of this.eventListeners)
        listener({ tabId: msg.tabId, method: "Hearth.detached", params: {} });
    } else if (msg.type === "tabs" && Array.isArray(msg.tabs)) {
      this.tabs = msg.tabs;
      this.notifyTabs();
    }
  }

  private drop(): void {
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    this.socket = null;
    this.tabs = [];
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new ActionError("unavailable", OFFLINE_MESSAGE));
      this.pending.delete(id);
    }
    this.notifyTabs();
  }

  private notifyTabs(): void {
    for (const listener of this.tabListeners) listener(this.tabs, this.socket !== null);
  }
}
