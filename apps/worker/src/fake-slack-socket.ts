// Slack's Socket Mode in a test (D62): a real WebSocket server on this PC that hands out the
// address apps.connections.open would, says hello for Jarvis's app, sends envelopes and notes when
// each is acked, sends them again as Slack does when no ack came, says disconnect (a warning,
// refresh_requested, link_disabled), stops answering pings, and turns opens away with a 429.
import type { AddressInfo } from "node:net";
import { JARVIS_APP_ID, type SlackBotApi, SlackError } from "@hearth/modules";
import { type WebSocket, WebSocketServer } from "ws";

type Raw = Record<string, unknown>;

export class FakeSlackSocket {
  /** Every socket that connected, in order; closed ones stay. */
  readonly sockets: WebSocket[] = [];
  /** How many times apps.connections.open was answered with an address. */
  opens = 0;
  /** The next opens are refused with these, in turn: a Slack error code, and Retry-After in s. */
  refusals: { code: string; retryAfter?: number }[] = [];
  /** The app hello names. */
  helloApp = JARVIS_APP_ID;
  /** Holds hello back until sayHello(), to have two sockets open at once. */
  holdHello = false;
  team = "T1";
  botUser = "UJARVIS";
  /** When each envelope was acked, in ms after it was sent. */
  readonly acks = new Map<string, number>();
  private readonly sent = new Map<string, { at: number; envelope: Raw }>();
  private readonly silent = new Set<WebSocket>();
  private readonly arrivals: (() => void)[] = [];
  private next = 0;
  private readonly server: WebSocketServer;

  private constructor(server: WebSocketServer) {
    this.server = server;
    server.on("connection", (socket) => {
      this.sockets.push(socket);
      socket.on("ping", (data) => {
        if (!this.silent.has(socket)) socket.pong(data);
      });
      socket.on("message", (data) => {
        const id = (JSON.parse(String(data)) as Raw).envelope_id;
        const sent = typeof id === "string" ? this.sent.get(id) : undefined;
        if (sent && !this.acks.has(id as string)) this.acks.set(id as string, Date.now() - sent.at);
      });
      if (!this.holdHello) this.sayHello(socket);
      for (const wake of this.arrivals.splice(0)) wake();
    });
  }

  static async start(): Promise<FakeSlackSocket> {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0, autoPong: false });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    return new FakeSlackSocket(server);
  }

  private get url() {
    return `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}/link/?ticket=${this.opens}`;
  }

  /** The bot's side of Slack, with apps.connections.open answered by this server. */
  api(base: SlackBotApi): SlackBotApi {
    return {
      ...base,
      openSocket: async (token) => {
        const { scopes } = await base.openSocket(token);
        const refused = this.refusals.shift();
        if (refused) throw new SlackError(refused.code, refused.retryAfter);
        this.opens++;
        return { url: this.url, scopes };
      },
    };
  }

  /** Waits until `n` sockets have connected, and gives the nth. */
  async socket(n: number, ms = 5000): Promise<WebSocket> {
    const until = Date.now() + ms;
    while (this.sockets.length < n) {
      if (Date.now() > until) throw new Error(`Socket ${n} never connected`);
      await new Promise<void>((wake) => {
        this.arrivals.push(wake);
        setTimeout(wake, 50);
      });
    }
    return this.sockets[n - 1]!;
  }

  get latest(): WebSocket {
    const s = this.sockets.at(-1);
    if (!s) throw new Error("No socket connected");
    return s;
  }

  sayHello(socket = this.latest) {
    socket.send(
      JSON.stringify({
        type: "hello",
        num_connections: this.sockets.filter((s) => s.readyState === s.OPEN).length,
        connection_info: { app_id: this.helloApp },
        debug_info: { host: "fake" },
      }),
    );
  }

  /** An events_api payload for `event`, as Slack sends it for Jarvis's bot. */
  payload(event: Raw, over: Raw = {}): Raw {
    this.next++;
    return {
      token: "unused",
      team_id: this.team,
      api_app_id: JARVIS_APP_ID,
      event,
      type: "event_callback",
      event_id: `Ev${this.next}`,
      event_time: 1,
      authorizations: [{ team_id: this.team, user_id: this.botUser, is_bot: true }],
      ...over,
    };
  }

  /** Sends an envelope; returns its id. */
  send(payload: Raw, socket = this.latest, retryAttempt = 0): string {
    const id = `env-${++this.next}`;
    const envelope = {
      envelope_id: id,
      type: "events_api",
      accepts_response_payload: false,
      retry_attempt: retryAttempt,
      retry_reason: retryAttempt ? "timeout" : "",
      payload,
    };
    this.sent.set(id, { at: Date.now(), envelope });
    socket.send(JSON.stringify(envelope));
    return id;
  }

  /** Sends an envelope again, as Slack does when no ack came: a new id, the same payload. */
  redeliver(id: string, socket = this.latest): string {
    const was = this.sent.get(id);
    if (!was) throw new Error(`No envelope ${id}`);
    const attempt = Number(was.envelope.retry_attempt) + 1;
    return this.send(was.envelope.payload as Raw, socket, attempt);
  }

  disconnect(reason: string, socket = this.latest) {
    socket.send(JSON.stringify({ type: "disconnect", reason, debug_info: { host: "fake" } }));
  }

  /** Stops answering this socket's pings, as a socket that died while the PC slept. */
  silence(socket = this.latest) {
    this.silent.add(socket);
  }

  /** Resolves with how long the ack took; rejects if none came in `ms`. */
  async acked(id: string, ms = 3000): Promise<number> {
    const until = Date.now() + ms;
    while (!this.acks.has(id)) {
      if (Date.now() > until) throw new Error(`${id} was never acked`);
      await new Promise((r) => setTimeout(r, 10));
    }
    return this.acks.get(id)!;
  }

  async close() {
    for (const s of this.sockets) s.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** A member's DM to Jarvis, as message.im brings it. */
export const dm = (user: string, text: string, ts: string, extra: Raw = {}): Raw => ({
  type: "message",
  channel: `D${user}`,
  channel_type: "im",
  user,
  text,
  ts,
  event_ts: ts,
  team: "T1",
  ...extra,
});
