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

export interface OpenTiming {
  /** After Hearth starts, how long a running Chrome gets to reconnect before another is opened. */
  startGraceMs: number;
  /** After the link drops, how long Chrome gets to come back by itself. */
  dropGraceMs: number;
  /** How long Chrome gets to connect once it's been asked to start. */
  connectMs: number;
  /** After a try fails, how long before Hearth tries again by itself. You can try any time. */
  retryMs: number;
}

export const OPEN_TIMING: OpenTiming = {
  startGraceMs: 30_000,
  dropGraceMs: 10_000,
  connectMs: 30_000,
  retryMs: 5 * 60_000,
};

export interface BridgeOptions {
  /** Opens Chrome when it's closed. Without one, you open Chrome yourself. */
  launcher?: ChromeLauncher | null;
  timing?: Partial<OpenTiming>;
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
  private readonly launcher: ChromeLauncher | null;
  private readonly timing: OpenTiming;
  private readonly startedAt = Date.now();
  private droppedAt = 0;
  private opening: Promise<void> | null = null;
  /** You asked to open Chrome now: skip the wait for a running Chrome to reconnect. */
  private hurry = false;
  private failure: { message: string; at: number } | null = null;
  /** Wakes everything waiting for Chrome: on connect, or when you ask to open it now. */
  private readonly wakers = new Set<() => void>();

  constructor(opts: BridgeOptions = {}) {
    this.launcher = opts.launcher ?? null;
    this.timing = { ...OPEN_TIMING, ...opts.timing };
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
    this.failure = null;
    this.wake();
    this.notify();
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
      canOpen: this.launcher !== null,
      opening: this.opening !== null,
      openError: this.failure?.message ?? null,
    };
  }

  /**
   * Makes sure Chrome is connected, opening it if it's closed. A running Chrome gets a moment to
   * reconnect first (Hearth just restarted, say). After a failed try, Hearth waits a few minutes
   * before trying again by itself; `now` (you pressed Open Chrome) skips both waits.
   */
  async open(opts: { now?: boolean } = {}): Promise<void> {
    if (this.socket) return;
    if (!this.launcher) throw new ActionError("unavailable", OFFLINE_MESSAGE);
    const recent = this.failure && Date.now() - this.failure.at < this.timing.retryMs;
    if (recent && !opts.now && !this.opening)
      throw new ActionError("unavailable", this.failure?.message ?? OFFLINE_MESSAGE);
    if (opts.now) this.hurry = true;
    if (!this.opening) {
      this.opening = this.tryOpen(this.launcher).finally(() => {
        this.opening = null;
        this.hurry = false;
        this.notify();
      });
      this.notify();
    } else if (opts.now) this.wake();
    return this.opening;
  }

  private async tryOpen(launcher: ChromeLauncher): Promise<void> {
    const now = Date.now();
    const grace = Math.max(
      this.startedAt + this.timing.startGraceMs - now,
      this.droppedAt + this.timing.dropGraceMs - now,
    );
    if (!this.hurry && grace > 0 && (await this.connected(grace))) return;
    if (this.socket) return;
    try {
      await launcher.open();
    } catch (err) {
      throw this.fail(err instanceof Error ? err.message : String(err));
    }
    if (await this.connected(this.timing.connectMs, true)) return;
    const seconds = Math.round(this.timing.connectMs / 1000);
    throw this.fail(
      [
        `Hearth started Chrome, but the Hearth extension didn't connect within ${seconds} seconds.`,
        launcher.hint,
        "Check that the extension is installed and paired in that Chrome (Settings → Chrome).",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  private fail(message: string): ActionError {
    this.failure = { message, at: Date.now() };
    return new ActionError("unavailable", message);
  }

  /** Waits up to `ms` for the extension to connect. Asking to open now cuts a grace wait short. */
  private connected(ms: number, untilConnected = false): Promise<boolean> {
    if (this.socket) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => {
        if (untilConnected && !this.socket) return;
        clearTimeout(timer);
        this.wakers.delete(done);
        resolve(this.socket !== null);
      };
      const timer = setTimeout(() => {
        this.wakers.delete(done);
        resolve(this.socket !== null);
      }, ms);
      this.wakers.add(done);
    });
  }

  private wake(): void {
    for (const waker of [...this.wakers]) waker();
  }

  /** Sends a request to Chrome. Opening a tab opens Chrome too, if it's closed. */
  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 45_000,
  ): Promise<T> {
    if (!this.socket && method === "tabs.open" && this.launcher) await this.open();
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
      this.notify();
    }
  }

  private drop(): void {
    if (this.ping) clearInterval(this.ping);
    if (this.socket) this.droppedAt = Date.now();
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
