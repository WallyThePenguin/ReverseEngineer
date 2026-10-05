// Jarvis's Slack socket, held by the worker (D62). The worker is the always-on service that
// already syncs Slack, and the only process that opens the bot's and the app's tokens. This
// listens only: what it hears is stored in slack_inbound for the take loop, and nothing is posted.
//
// - It listens only where it should: once members can talk to Jarvis (slack.bot.membersOn), on the
//   install that connected the bot (a dev copy on a restored database can't take the live
//   events), and not while Slack has it revoked. New tokens start it over.
// - It connects with apps.connections.open and waits for hello. A dropped socket is tried again
//   after 1, 2, 5, 15, 30, 60, then 120 s (±20%), never sooner than Slack's Retry-After; a socket
//   that stayed up five minutes starts the ladder over. When Slack warns it will close a socket, or
//   asks for a fresh one, the new socket opens before the old one closes.
// - Revoked (Socket Mode off, the app uninstalled, its tokens revoked) stops it: the health
//   component sync.slack_bot says so at once, which tells you once a day, and nothing reconnects
//   until slack.bot_replace_tokens takes new tokens.
// - On each hello and every 10 minutes it catches up on what it may have missed (catchup.ts).
import { slackBot } from "@hearth/db";
import { getSetting, type Kernel } from "@hearth/kernel";
import {
  BACKOFF_RESET_MS,
  type BotDown,
  type BotRow,
  backoffMs,
  botTrouble,
  CATCH_UP_EVERY_MS,
  catchUp,
  holdsSocket,
  INSTALL_SERVICE,
  type InboundStore,
  type Install,
  openBotToken,
  REVOKED_CODES,
  SLACK_BOT_SERVICE,
  type SlackBotApi,
  SlackError,
  saveBotHealth,
} from "@hearth/modules";
import { BotSocket, NoHello, SOCKET_TIMINGS, type SocketTimings } from "./slack-socket.ts";

export interface SlackBotOptions extends Partial<SocketTimings> {
  kernel: Kernel;
  /** The ack path's own connection (inbound.ts). */
  inbound: InboundStore;
  log?: (msg: string, err?: unknown) => void;
  /** How often it looks again at whether it should be listening. */
  checkEveryMs?: number;
  catchUpEveryMs?: number;
  random?: () => number;
  /** Waits between tries; resolves early when the listener stops. */
  sleep?: (ms: number, stop: AbortSignal) => Promise<void>;
  /** Milliseconds on a clock that only goes forward: how long a socket stayed up. */
  elapsed?: () => number;
}

const CHECK_EVERY_MS = 30_000;

/** The options with every default filled in. */
type Settled = Required<Omit<SlackBotOptions, keyof SocketTimings>> & SocketTimings;

const sleepFor = (ms: number, stop: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    const early = () => {
      clearTimeout(t);
      resolve();
    };
    stop.addEventListener("abort", early, { once: true });
  });

/** A Slack code for what went wrong, as health and the backoff want it. */
function codeOf(err: unknown): { code: string; retryAfter?: number } {
  if (err instanceof NoHello) return { code: err.code };
  if (err instanceof SlackError) return { code: err.code, retryAfter: err.retryAfter };
  // The network, or tokens the vault couldn't open: worth trying again, and saying why.
  return { code: err instanceof Error ? err.message : "unreachable" };
}

/** One bot, with one set of tokens, listening until it's stopped or revoked. */
class Listener {
  readonly key: string;
  stopped = false;
  private readonly stop$ = new AbortController();
  private readonly sockets = new Set<BotSocket>();
  private current: BotSocket | null = null;
  private attempt = 0;
  private upSince = 0;
  private catching: Promise<unknown> | null = null;
  private readonly tick: ReturnType<typeof setInterval>;
  private readonly row: BotRow;
  private readonly o: Settled;

  constructor(row: BotRow, o: Settled) {
    this.row = row;
    this.o = o;
    this.key = keyOf(row);
    this.tick = setInterval(() => void this.catchUp(true), o.catchUpEveryMs);
    void this.run().catch((err) => this.o.log("Jarvis's Slack socket stopped", err));
  }

  private get now() {
    return this.o.kernel.clock.now();
  }

  private get services() {
    const services = this.o.kernel.services;
    return {
      service: <T>(name: string): T => {
        if (!services[name]) throw new Error(`The ${name} isn't available in the worker.`);
        return services[name] as T;
      },
    };
  }

  get connected(): boolean {
    return Boolean(this.current?.open);
  }

  private async run() {
    let wait = false;
    while (!this.stopped) {
      const next = await this.connect(wait);
      if (!next) return;
      // A handover: the new socket is up, so the old one goes.
      if (this.current) this.drop(this.current);
      this.current = next;
      const end = await next.ended;
      if (this.stopped) return;
      if (end.kind === "revoked") return this.revoke(end.code);
      // Slack asked for a new socket: open it now, while this one still listens.
      wait = end.kind === "lost";
      if (end.kind === "handover") continue;
      this.drop(next);
      this.current = null;
      if (this.o.elapsed() - this.upSince >= BACKOFF_RESET_MS) this.attempt = 0;
      this.o.log(`Jarvis's Slack socket closed (${end.why}); connecting again.`);
    }
  }

  /** A socket Slack said hello on, or null once stopped or revoked. */
  private async connect(waitFirst: boolean): Promise<BotSocket | null> {
    // Down since now, when this process saw the socket go or started without one: the last hello
    // may be from before the PC slept, and only 30 minutes down that the worker saw is failing.
    const since = this.now;
    let wait = waitFirst;
    let retryAfter: number | undefined;
    while (!this.stopped) {
      if (wait) {
        await this.o.sleep(backoffMs(this.attempt++, this.o.random, retryAfter), this.stop$.signal);
        if (this.stopped) return null;
      }
      wait = true;
      let socket: BotSocket | null = null;
      try {
        const api = this.services.service<SlackBotApi>(SLACK_BOT_SERVICE);
        const { url } = await api.openSocket(openBotToken(this.services, this.row, "app"));
        if (this.stopped) return null;
        socket = new BotSocket({
          ...this.o,
          url,
          ours: { appId: this.row.appId, teamId: this.row.teamId, botUserId: this.row.botUserId },
          now: () => this.now,
        });
        this.sockets.add(socket);
        await socket.hello;
      } catch (err) {
        if (socket) this.drop(socket);
        if (this.stopped) return null;
        const { code, retryAfter: after } = codeOf(err);
        if (REVOKED_CODES.has(code)) {
          await this.revoke(code);
          return null;
        }
        retryAfter = after;
        this.o.log(`Jarvis's Slack socket couldn't connect: ${code}`);
        await this.health({ trouble: botTrouble(code), since });
        continue;
      }
      if (this.stopped) {
        this.drop(socket);
        return null;
      }
      this.upSince = this.o.elapsed();
      await this.health(null);
      void this.catchUp(false);
      return socket;
    }
    return null;
  }

  /** Saves how the socket is doing; a database blip here mustn't drop a good socket. */
  private async health(down: BotDown | null) {
    await saveBotHealth(this.o.kernel.db, this.row.teamId, this.now, down).catch((err) =>
      this.o.log("Saving the Slack socket's health failed", err),
    );
  }

  /** Catches up, one round at a time. `heartbeat`: also says the socket is still connected. */
  private catchUp(heartbeat: boolean): Promise<unknown> {
    if (this.catching || this.stopped) return this.catching ?? Promise.resolve();
    const round = (async () => {
      if (heartbeat && this.connected) await this.health(null);
      const done = await catchUp(this.o.kernel.db, this.services, this.row.teamId, this.now);
      for (const e of done.errors) this.o.log(`Catching up on Slack: ${e}`);
      return done;
    })()
      .catch(async (err) => {
        const { code } = codeOf(err);
        if (REVOKED_CODES.has(code)) await this.revoke(code);
        else this.o.log("Catching up on Slack failed", err);
      })
      .finally(() => {
        this.catching = null;
      });
    this.catching = round;
    return round;
  }

  private async revoke(code: string) {
    this.halt();
    await this.health({ trouble: botTrouble(code), since: this.now });
    this.o.log(`Slack revoked Jarvis's bot (${code}); it waits for new tokens.`);
  }

  private drop(socket: BotSocket) {
    socket.close();
    this.sockets.delete(socket);
  }

  halt() {
    this.stopped = true;
    this.stop$.abort();
    clearInterval(this.tick);
    for (const s of this.sockets) s.close();
    this.sockets.clear();
    this.current = null;
  }
}

/** New tokens (connecting again, or replacing them) start a new listener. */
const keyOf = (row: BotRow) => `${row.teamId}:${row.connectedAt.toISOString()}`;

export interface SlackBot {
  /** Starts or stops listening to match the settings and the bot's row. */
  check(): Promise<void>;
  /** Whether a socket is up now. */
  connected(): boolean;
  stop(): void;
}

export function startSlackBot(opts: SlackBotOptions): SlackBot {
  const o: Settled = {
    ...SOCKET_TIMINGS,
    log: (m: string, e?: unknown) => console.error(`[slack-bot] ${m}`, e ?? ""),
    checkEveryMs: CHECK_EVERY_MS,
    catchUpEveryMs: CATCH_UP_EVERY_MS,
    random: Math.random,
    sleep: sleepFor,
    elapsed: () => performance.now(),
    ...opts,
  };
  const { kernel } = o;
  let listener: Listener | null = null;
  let checking: Promise<void> | null = null;
  let stopped = false;
  let toldElsewhere = false;

  /** The bot this worker should listen for, or null. */
  async function wanted(): Promise<BotRow | null> {
    const [row] = await kernel.db.select().from(slackBot).limit(1);
    if (!row || row.syncState === "revoked") return null;
    const membersOn = await getSetting(kernel.db, "slack.bot.membersOn");
    // A worker that can't tell which install it is doesn't listen: it might be a copy.
    const install = kernel.services[INSTALL_SERVICE] as Install | undefined;
    const id = install?.id() ?? null;
    const here = id !== null && holdsSocket(row, membersOn, id);
    const elsewhere = membersOn && !here;
    if (elsewhere && !toldElsewhere)
      o.log("Jarvis's Slack bot was connected on another install of Hearth; not listening here.");
    toldElsewhere = elsewhere;
    return here ? row : null;
  }

  async function look() {
    const row = await wanted();
    if (stopped) return;
    if (listener && (listener.stopped || !row || listener.key !== keyOf(row))) {
      listener.halt();
      listener = null;
    }
    if (!listener && row) listener = new Listener(row, o);
  }

  const check = () => {
    checking ??= look().finally(() => {
      checking = null;
    });
    return checking;
  };
  const timer = setInterval(
    () => void check().catch((err) => o.log("Checking on Jarvis's Slack bot failed", err)),
    o.checkEveryMs,
  );
  void check().catch((err) => o.log("Checking on Jarvis's Slack bot failed", err));

  return {
    check,
    connected: () => listener?.connected ?? false,
    stop() {
      stopped = true;
      clearInterval(timer);
      listener?.halt();
      listener = null;
    },
  };
}
