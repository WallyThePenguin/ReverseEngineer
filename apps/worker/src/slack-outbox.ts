// Jarvis's Slack outbox sender, run by the worker (D62): the one process that posts as the bot.
// A new row's pg_notify wakes it at once; it also looks every 5 s, and comes back after a second
// while the pace holds posts back. It sends only where the socket is held (holdsSocket): once
// members are on, on the install that connected the bot, so a dev copy on a restored database
// never posts to the live workspace. The sending itself, each post once, is outbox.ts.
import { slackBot } from "@hearth/db";
import { getSetting, type Kernel, listenChannels } from "@hearth/kernel";
import {
  holdsSocket,
  INSTALL_SERVICE,
  type Install,
  OUTBOX_CHANNEL,
  OUTBOX_POLL_MS,
  type OutboxRound,
  PACE_MS,
  sendOutbox,
} from "@hearth/modules";

export interface SlackOutboxOptions {
  kernel: Kernel;
  /** Where a new row is heard (LISTEN). Without it the sender only looks every `pollMs`. */
  pool?: Parameters<typeof listenChannels>[0];
  log?: (msg: string, err?: unknown) => void;
  pollMs?: number;
  /** How soon it looks again when the pace held posts back. */
  paceMs?: number;
}

export interface SlackOutbox {
  /** Sends what's due now (one round at a time; a wake mid-round runs one more). */
  wake(): Promise<void>;
  /** The last round, for tests and logs. */
  last(): OutboxRound | null;
  /** Whether a new post wakes it now (its LISTEN is up). */
  listening(): boolean;
  stop(): Promise<void>;
}

/**
 * Whether this worker acts for Jarvis's bot: the same rule as holding its socket. The outbox
 * posts and the take loop takes only here (D62).
 */
export async function holdsBotHere(kernel: Kernel): Promise<boolean> {
  const [row] = await kernel.db.select().from(slackBot).limit(1);
  if (!row) return false;
  const membersOn = await getSetting(kernel.db, "slack.bot.membersOn");
  // A worker that can't tell which install it is doesn't act: it might be a copy.
  const id = (kernel.services[INSTALL_SERVICE] as Install | undefined)?.id() ?? null;
  return id !== null && holdsSocket(row, membersOn, id);
}

export function startSlackOutbox(opts: SlackOutboxOptions): SlackOutbox {
  const { kernel } = opts;
  const log =
    opts.log ?? ((m: string, e?: unknown) => console.error(`[slack-outbox] ${m}`, e ?? ""));
  const pollMs = opts.pollMs ?? OUTBOX_POLL_MS;
  const paceMs = opts.paceMs ?? PACE_MS;
  let stopped = false;
  let running: Promise<void> | null = null;
  let again = false;
  let last: OutboxRound | null = null;
  let listening = false;
  let stopping: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const later = (ms: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void wake(), ms);
  };

  async function round() {
    let next = pollMs;
    try {
      if (await holdsBotHere(kernel)) {
        last = await sendOutbox(kernel);
        if (last.more) next = paceMs;
      }
    } catch (err) {
      log("Sending Jarvis's Slack posts failed", err);
    }
    later(next);
  }

  function wake(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await round();
      } while (again && !stopped);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  const unlisten = opts.pool
    ? listenChannels(opts.pool, [OUTBOX_CHANNEL], () => void wake(), {
        // Anything added while the connection was down is picked up at once.
        onListening: () => {
          listening = true;
          void wake();
        },
        log: (line) => log(line),
      })
    : null;
  void wake();

  return {
    wake,
    last: () => last,
    listening: () => listening,
    // The worker's stop and main's both ask; the second waits for the first.
    stop() {
      stopping ??= (async () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        await unlisten?.();
        await running;
      })();
      return stopping;
    },
  };
}
