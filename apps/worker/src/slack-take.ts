// The take loop, run by the worker (D62): every 2 s, one round at a time, what members wrote to
// Jarvis's bot is taken (modules slack/member/take.ts). Each round first asks Slack who's writing
// (slack.check_members, your own token, which only reads), then takes their messages: their
// conversation, the limits, and a turn or a relay. Ending turns are settled here too, so a member
// whose turn never answered gets the apology and you get the relay even with Jarvis stopped.
// It runs only where the socket is held, so a copy of Hearth on a restored database takes nothing.
import { integrationCaller, type Kernel } from "@hearth/kernel";
import type { TakeRound } from "@hearth/modules";
import { holdsBotHere } from "./slack-outbox.ts";

/** How often a round runs (D62). */
export const TAKE_EVERY_MS = 2_000;
/** After Slack refuses a lookup, who's writing is asked again this much later. */
const CHECK_COOL_MS = 60_000;

export interface SlackTakeOptions {
  kernel: Kernel;
  log?: (msg: string, err?: unknown) => void;
  everyMs?: number;
}

export interface SlackTake {
  /** Runs a round now, or waits for the one running. */
  round(): Promise<TakeRound | null>;
  stop(): Promise<void>;
}

export function startSlackTake(opts: SlackTakeOptions): SlackTake {
  const { kernel } = opts;
  const log = opts.log ?? ((m: string, e?: unknown) => console.error(`[slack-take] ${m}`, e ?? ""));
  const slack = integrationCaller("slack");
  let running: Promise<TakeRound | null> | null = null;
  let stopped = false;
  let checkAfter = 0;

  async function once(): Promise<TakeRound | null> {
    if (!(await holdsBotHere(kernel))) return null;
    const now = kernel.clock.now().getTime();
    if (now >= checkAfter) {
      const c = await kernel.execute<{ checked: number; stopped?: string }>(
        "slack.check_members",
        {},
        slack,
      );
      if (c.status !== "ok" || c.result.stopped) {
        checkAfter = now + CHECK_COOL_MS;
        log(`looking up who wrote to Jarvis paused a minute: ${JSON.stringify(c)}`);
      }
    }
    const res = await kernel.execute<TakeRound>("slack.take", {}, slack);
    if (res.status !== "ok") {
      log(`taking Slack messages failed: ${JSON.stringify(res)}`);
      return null;
    }
    return res.result;
  }

  function round(): Promise<TakeRound | null> {
    if (stopped) return Promise.resolve(null);
    running ??= once()
      .catch((err) => {
        log("taking Slack messages failed", err);
        return null;
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  const timer = setInterval(() => void round(), opts.everyMs ?? TAKE_EVERY_MS);
  timer.unref?.();
  return {
    round,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
