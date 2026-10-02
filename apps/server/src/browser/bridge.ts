// The server's end of the Hearth extension (D24): one WebSocket from your Chrome, requests out,
// results and page events back. Jarvis, the worker and the live view all go through here. When
// Jarvis opens a page and Chrome is closed, this opens Chrome first (D28).
import { ActionError } from "@hearth/kernel";
import {
  type BrowserClient,
  type BrowserStatus,
  OFFLINE_MESSAGE,
  type TabInfo,
} from "@hearth/modules";
import type { WebSocket } from "ws";
import type { ChromeLauncher } from "./launch.ts";
import { ChromeOpener, type OpenTiming } from "./opener.ts";

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

/** How long Chrome gets to answer one request. */
export const CALL_TIMEOUT_MS = 45_000;

export interface BridgeOptions {
  /** Opens Chrome when it's closed. Without one, you open Chrome yourself. */
  launcher?: ChromeLauncher | null;
  timing?: Partial<OpenTiming>;
  /** Whether an extension is paired. Opening Chrome only helps if one is. */
  isPaired?: () => Promise<boolean>;
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
  private readonly stateListeners = new Set<(status: BrowserStatus) => void>();
  private readonly opener: ChromeOpener;
  /** Whether an extension is paired, as last seen. Null until known. */
  private paired: boolean | null = null;

  constructor(opts: BridgeOptions = {}) {
    const isPaired = opts.isPaired ?? (async () => true);
    const check = async () => {
      this.paired = await isPaired();
      return this.paired;
    };
    this.opener = new ChromeOpener({
      launcher: opts.launcher ?? null,
      timing: opts.timing,
      isPaired: check,
      isConnected: () => this.socket !== null,
      changed: () => this.notify(),
    });
    void check().then(
      () => this.notify(),
      () => {},
    );
  }

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
    this.paired = true;
    this.opener.connected();
    this.notify();
  }

  /** An extension's hello was turned away: it has an old pairing code. */
  turnedAway(): void {
    this.opener.turnedAwayHello();
  }

  async status(): Promise<BrowserStatus> {
    return this.snapshot();
  }

  snapshot(): BrowserStatus {
    return {
      connected: this.socket !== null,
      version: this.version,
      since: this.since?.toISOString() ?? null,
      tabs: this.tabs,
      ...this.opener.state(),
      ...(this.paired === null ? {} : { paired: this.paired }),
    };
  }

  /**
   * Makes sure Chrome is connected, opening it if it's closed (D28). `now` means you asked: no
   * waiting for a running Chrome to reconnect, or out a failed try.
   */
  open(opts: { now?: boolean } = {}): Promise<void> {
    return this.opener.open(opts);
  }

  /** Sends a request to Chrome. Opening a tab opens Chrome too, if it's closed. */
  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.socket && method === "tabs.open" && this.opener.state().canOpen) await this.open();
    const ws = this.socket;
    if (!ws) throw new ActionError("unavailable", OFFLINE_MESSAGE);
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

  /** Whether Chrome is connected or being opened, and Jarvis's tabs, whenever they change. */
  onState(listener: (status: BrowserStatus) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Pairing changed: drops the extension's link. A paired one connects again by itself. */
  pairingChanged(paired: boolean): void {
    this.paired = paired;
    this.socket?.close(1001, "Pairing changed");
    this.drop();
    this.opener.pairingChanged();
    this.notify();
  }

  /** Hearth is stopping: drop the link and stop waiting for Chrome. */
  close(): void {
    this.opener.stop();
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
      this.notify();
    }
  }

  private drop(): void {
    if (this.ping) clearInterval(this.ping);
    if (this.socket) this.opener.dropped();
    this.ping = null;
    this.socket = null;
    this.tabs = [];
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new ActionError("unavailable", OFFLINE_MESSAGE));
      this.pending.delete(id);
    }
    this.notify();
  }

  private notify(): void {
    const status = this.snapshot();
    for (const listener of this.stateListeners) listener(status);
  }
}
