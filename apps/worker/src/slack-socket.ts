// One Socket Mode connection for Jarvis's bot (D62). It uses `ws`, as the server does: Node's own
// WebSocket can't see pings, so it would either reconnect every quiet minute or miss a socket that
// died while the PC slept. Every 20 seconds it pings, and a pong that doesn't come within 10 means
// the socket is dead: it's dropped and slack-bot.ts connects again. Each envelope is stored, then
// acked (inbound.ts). A disconnect is passed up for slack-bot.ts to act on.
import {
  ackOf,
  type InboundStore,
  type Ours,
  onDisconnect,
  parseFrame,
  receive,
} from "@hearth/modules";
import WebSocket from "ws";

/** Why a socket stopped being the one to listen on. */
export type SocketEnd =
  /** Slack wants a new socket; this one still works until it closes, so open the next first. */
  | { kind: "handover" }
  /** Slack revoked Jarvis (Socket Mode off, the app uninstalled, its tokens revoked). */
  | { kind: "revoked"; code: string }
  /** Closed, silent, or told to reconnect. */
  | { kind: "lost"; why: string };

export interface SocketTimings {
  pingEveryMs: number;
  pongWaitMs: number;
  helloWaitMs: number;
}

export const SOCKET_TIMINGS: SocketTimings = {
  pingEveryMs: 20_000,
  pongWaitMs: 10_000,
  helloWaitMs: 15_000,
};

/** A socket that never said hello, and why: a Slack code, as SlackError would carry. */
export class NoHello extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Slack's socket didn't say hello: ${code}`);
    this.code = code;
    this.name = "NoHello";
  }
}

export interface BotSocketOptions extends SocketTimings {
  url: string;
  ours: Ours;
  inbound: Pick<InboundStore, "store">;
  now: () => Date;
  log: (msg: string, err?: unknown) => void;
}

export class BotSocket {
  /** Resolves once Slack says hello for Jarvis's app; rejects with NoHello. */
  readonly hello: Promise<void>;
  readonly ended: Promise<SocketEnd>;
  private readonly ws: WebSocket;
  private greeted = false;
  private over = false;
  private readonly helloTimer: ReturnType<typeof setTimeout>;
  private pinger: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private settleHello!: (err?: NoHello) => void;
  private settleEnd!: (end: SocketEnd) => void;
  private readonly o: BotSocketOptions;

  constructor(o: BotSocketOptions) {
    this.o = o;
    this.hello = new Promise((resolve, reject) => {
      this.settleHello = (err) => (err ? reject(err) : resolve());
    });
    // Nobody waits on hello once the socket has given up on it.
    this.hello.catch(() => {});
    this.ended = new Promise((resolve) => {
      this.settleEnd = resolve;
    });
    this.ws = new WebSocket(o.url);
    this.helloTimer = setTimeout(() => {
      this.end({ kind: "lost", why: "no_hello" });
      this.close();
    }, o.helloWaitMs);
    this.ws.on("message", (data) => this.heard(String(data)));
    this.ws.on("pong", () => {
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = null;
    });
    this.ws.on("error", (err) => this.o.log("Jarvis's Slack socket had an error", err));
    this.ws.on("close", (code) => {
      this.stopPinging();
      this.end({ kind: "lost", why: `closed (${code})` });
    });
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  private heard(data: string) {
    const frame = parseFrame(data);
    if (!frame) return;
    if (frame.type === "hello") {
      clearTimeout(this.helloTimer);
      if (frame.appId !== this.o.ours.appId) {
        this.end({ kind: "lost", why: "wrong_app" });
        return this.close();
      }
      this.greeted = true;
      this.settleHello();
      this.pinger = setInterval(() => this.ping(), this.o.pingEveryMs);
      return;
    }
    if (frame.type === "disconnect") {
      const move = onDisconnect(frame.reason);
      if (move === "handover" && this.greeted) return this.end({ kind: "handover" });
      this.end(
        move === "revoked"
          ? { kind: "revoked", code: frame.reason }
          : { kind: "lost", why: frame.reason || "disconnect" },
      );
      return this.close();
    }
    if (frame.type !== "envelope") return;
    // Interactivity and slash commands are off: anything but an event is only acked.
    if (frame.kind !== "events_api") return this.ack(frame.envelopeId);
    void this.receive(frame.envelopeId, frame.payload);
  }

  private async receive(envelopeId: string, payload: Record<string, unknown>) {
    try {
      const heard = await receive(
        { envelopeId, payload },
        this.o.ours,
        this.o.inbound,
        (id) => this.ack(id),
        this.o.now(),
      );
      if (heard.kind === "revoked") this.end({ kind: "revoked", code: heard.code });
    } catch (err) {
      // Not stored, so not acked: Slack sends it again.
      this.o.log("Couldn't store a Slack event; Slack will send it again", err);
    }
  }

  private ack(envelopeId: string) {
    if (this.open) this.ws.send(ackOf(envelopeId));
  }

  private ping() {
    if (!this.open || this.pongTimer) return;
    this.ws.ping();
    this.pongTimer = setTimeout(() => {
      this.end({ kind: "lost", why: "no pong" });
      this.ws.terminate();
    }, this.o.pongWaitMs);
  }

  /** Says once why this socket stopped being the one to listen on. */
  private end(end: SocketEnd) {
    if (!this.greeted)
      this.settleHello(
        new NoHello(end.kind === "revoked" ? end.code : end.kind === "lost" ? end.why : end.kind),
      );
    if (this.over) return;
    this.over = true;
    clearTimeout(this.helloTimer);
    this.settleEnd(end);
  }

  private stopPinging() {
    if (this.pinger) clearInterval(this.pinger);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pinger = null;
    this.pongTimer = null;
  }

  /** Closes it, and drops it if Slack doesn't answer the close in a second. */
  close() {
    this.end({ kind: "lost", why: "closed by Hearth" });
    this.stopPinging();
    if (this.ws.readyState === WebSocket.CLOSED) return;
    this.ws.close(1000);
    const drop = setTimeout(() => this.ws.terminate(), 1000);
    drop.unref?.();
    this.ws.once("close", () => clearTimeout(drop));
  }
}
