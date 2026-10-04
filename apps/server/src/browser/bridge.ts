// The server's end of the Hearth extension (D24, D52): one WebSocket from your Chrome, requests
// out, results and page events back. Jarvis, the worker and the live view all go through here.
// When Jarvis opens a page and Chrome is closed, this opens Chrome first (D28). The link speaks
// protocol 2, is dropped when it misses two pings, and keeps a short log of what happened on it.
import { ActionError } from "@hearth/kernel";
import {
  BRIDGE_PROTOCOL,
  type BrowserClient,
  type BrowserStatus,
  chromeError,
  EXTENSION_ID,
  OFFLINE_MESSAGE,
  type TabInfo,
} from "@hearth/modules";
import type { WebSocket } from "ws";
import { BridgeLog } from "./bridge-log.ts";
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
  ws: WebSocket;
  method: string;
  at: number;
}

/** What an extension said about itself when it connected. */
export interface Hello {
  version: string;
  /** The link protocol it speaks; extensions from before protocol 2 don't say (1). */
  protocol: number;
  /** Its ID, from the Origin it connected with. */
  extensionId: string | null;
}

/** How long Chrome gets to answer one request. */
export const CALL_TIMEOUT_MS = 45_000;
/** How often the link is pinged; two pings without a pong drop it. */
export const PING_MS = 20_000;

export interface BridgeOptions {
  /** Opens Chrome when it's closed. Without one, you open Chrome yourself. */
  launcher?: ChromeLauncher | null;
  timing?: Partial<OpenTiming>;
  /** Whether an extension is paired. Opening Chrome only helps if one is. */
  isPaired?: () => Promise<boolean>;
  pingMs?: number;
}

const method = (m: string, params: Record<string, unknown>) =>
  m === "cdp" ? `cdp ${String(params.method)}` : m;

export class BrowserBridge implements BrowserClient {
  /** Connects, drops, refusals and failed calls, newest last. */
  readonly log = new BridgeLog();
  private socket: WebSocket | null = null;
  private hello: Hello | null = null;
  private since: Date | null = null;
  private tabs: TabInfo[] = [];
  private nextId = 1;
  private ping: ReturnType<typeof setInterval> | null = null;
  private missed = 0;
  private readonly pingMs: number;
  private readonly pending = new Map<number, Pending>();
  private readonly eventListeners = new Set<(e: CdpEvent) => void>();
  private readonly stateListeners = new Set<(status: BrowserStatus) => void>();
  private readonly opener: ChromeOpener;
  /** Whether an extension is paired, as last seen. Null until known. */
  private paired: boolean | null = null;

  constructor(opts: BridgeOptions = {}) {
    const isPaired = opts.isPaired ?? (async () => true);
    this.pingMs = opts.pingMs ?? PING_MS;
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
  adopt(ws: WebSocket, hello: Hello): void {
    const old = this.socket;
    if (old && old !== ws) {
      // Calls sent on the old link will never be answered there.
      this.failPending(old, "Chrome reconnected before it answered. Try again.");
      old.close(4000, "Replaced by a newer connection");
      this.log.add("replaced", "A newer connection from Chrome replaced the old one.");
    }
    this.socket = ws;
    this.hello = hello;
    this.since = new Date();
    this.missed = 0;
    ws.on("message", (data) => this.receive(ws, String(data)));
    ws.on("close", () => {
      if (this.socket === ws) this.drop("Chrome disconnected.");
    });
    // Keeps the extension's service worker awake, and notices a link that died quietly.
    if (this.ping) clearInterval(this.ping);
    this.ping = setInterval(() => this.pingOnce(ws), this.pingMs);
    ws.send(JSON.stringify({ type: "welcome", protocol: BRIDGE_PROTOCOL }));
    // An older extension reloads itself from its folder, which an update has refreshed.
    if (hello.protocol < BRIDGE_PROTOCOL)
      ws.send(JSON.stringify({ type: "update", protocol: BRIDGE_PROTOCOL }));
    this.log.add(
      "connect",
      `Chrome connected (extension ${hello.version}, protocol ${hello.protocol}).`,
    );
    this.paired = true;
    this.opener.connected();
    this.notify();
  }

  /** An extension's hello was turned away. `old` when it had an earlier pairing code. */
  turnedAway(old = true): void {
    this.log.add(
      "reject",
      old
        ? "Turned away an extension with an old pairing code. Pair it again in Settings."
        : "Turned away a connection that didn't have the pairing code.",
    );
    if (old) this.opener.turnedAwayHello();
  }

  async status(): Promise<BrowserStatus> {
    return this.snapshot();
  }

  snapshot(): BrowserStatus {
    const connected = this.socket !== null;
    return {
      connected,
      version: this.hello?.version ?? null,
      since: this.since?.toISOString() ?? null,
      tabs: this.tabs,
      ...this.opener.state(),
      ...(this.paired === null ? {} : { paired: this.paired }),
      protocol: connected ? (this.hello?.protocol ?? null) : null,
      extensionId: connected ? (this.hello?.extensionId ?? null) : null,
      expectedId: EXTENSION_ID,
      problem: connected ? this.problem() : null,
    };
  }

  /** What's wrong with the connected extension, for you, or null. */
  private problem(): string | null {
    const hello = this.hello;
    if (!hello) return null;
    if (hello.protocol < BRIDGE_PROTOCOL)
      return "Chrome's Hearth extension is out of date. It reloads itself; if this stays, open chrome://extensions and press reload on Hearth.";
    if (hello.extensionId && hello.extensionId !== EXTENSION_ID)
      return "A Hearth extension with a different ID is connected. Load the extension from Hearth's own folder, then pair it again.";
    return null;
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
    m: string,
    params: Record<string, unknown> = {},
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.socket && m === "tabs.open" && this.opener.state().canOpen) await this.open();
    const ws = this.socket;
    if (!ws) throw new ActionError("unavailable", OFFLINE_MESSAGE);
    const id = this.nextId++;
    const what = method(m, params);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.log.add("timeout", `Chrome didn't answer in time.`, { method: what, ms: timeoutMs });
        reject(new ActionError("failed", `Chrome didn't answer (${what}) in time.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        ws,
        method: what,
        at: Date.now(),
      });
      try {
        ws.send(JSON.stringify({ type: "call", id, method: m, params }));
      } catch {
        this.settle(id, new ActionError("unavailable", OFFLINE_MESSAGE));
      }
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
    this.drop(paired ? "Paired a new extension." : "Unpaired the extension.");
    this.opener.pairingChanged();
    this.notify();
  }

  /** Hearth is stopping: drop the link and stop waiting for Chrome. */
  close(): void {
    this.opener.stop();
    this.socket?.close(1001, "Hearth is stopping");
    this.drop("Hearth is stopping.");
  }

  private pingOnce(ws: WebSocket): void {
    if (this.socket !== ws) return;
    if (this.missed >= 2) {
      this.log.add("disconnect", "Chrome stopped answering pings, so the link was dropped.");
      ws.terminate();
      this.drop(null);
      return;
    }
    this.missed++;
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch {}
  }

  private settle(id: number, err: Error | null, result?: unknown): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(result);
  }

  private receive(ws: WebSocket, raw: string): void {
    let msg: {
      type?: string;
      id?: number;
      result?: unknown;
      error?: string;
      code?: string;
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
    if (msg.type === "pong") {
      if (this.socket === ws) this.missed = 0;
    } else if (msg.type === "result" && typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p || p.ws !== ws) return;
      const ms = Date.now() - p.at;
      if (msg.error) {
        const err = chromeError(msg.error, msg.code);
        // A dialog in the way is part of the work, not a fault in the link.
        if (msg.code !== "dialog_open")
          this.log.add("error", err.message, { method: p.method, ms });
        this.log.called(ms, msg.code !== "dialog_open");
        this.settle(msg.id, err);
      } else {
        this.log.called(ms, false);
        this.settle(msg.id, null, msg.result);
      }
    } else if (this.socket !== ws) {
      // A replaced link's events and tabs are old news.
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

  /** Fails the calls sent on one link: it closed, or another replaced it. */
  private failPending(ws: WebSocket | null, message: string): void {
    for (const [id, p] of this.pending)
      if (ws === null || p.ws === ws) this.settle(id, new ActionError("unavailable", message));
  }

  /** The link is gone. `why` goes to the log, unless it's already there. */
  private drop(why: string | null): void {
    if (this.ping) clearInterval(this.ping);
    if (this.socket) {
      this.opener.dropped();
      if (why) this.log.add("disconnect", why);
    }
    this.ping = null;
    this.socket = null;
    this.tabs = [];
    this.failPending(null, OFFLINE_MESSAGE);
    this.notify();
  }

  private notify(): void {
    const status = this.snapshot();
    for (const listener of this.stateListeners) listener(status);
  }
}
