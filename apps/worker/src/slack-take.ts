// The take loop, run by the worker (D62): every 2 s, one round at a time, what members wrote to
// Jarvis's bot is taken (modules slack/member/take.ts). Each round first asks Slack who's writing
// (slack.check_members, your own token, which only reads) and whether the channels Jarvis answers
// in still pass their hourly check (slack.check_channels), then takes their messages: their
// conversation, the limits, and a turn or a relay. Ending turns are settled here too, so a member
// whose turn never answered gets the apology and you get the relay even with Jarvis stopped.
// What you wrote in your own DM with Jarvis is taken too, as you via Slack, untrusted
// (slack.take_owner). It runs only where the socket is held, so a copy of Hearth on a restored
// database takes nothing.
import { integrationCaller, type Kernel, ownerCaller } from "@hearth/kernel";
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
  // You, writing in your DM with Jarvis: you, but through Slack, so untrusted (D62).
  const you = ownerCaller("slack", { origin: "untrusted" });
  let running: Promise<TakeRound | null> | null = null;
  let stopped = false;
  const after = { members: 0, channels: 0 };

  /** One of the lookups with your own token; Slack refusing it pauses that one a minute. */
  async function check(name: "members" | "channels", now: number) {
    if (now < after[name]) return;
    const c = await kernel.execute<{ stopped?: string }>(`slack.check_${name}`, {}, slack);
    if (c.status !== "ok" || c.result.stopped) {
      after[name] = now + CHECK_COOL_MS;
      log(`slack.check_${name} paused a minute: ${JSON.stringify(c)}`);
    }
  }

  async function once(): Promise<TakeRound | null> {
    if (!(await holdsBotHere(kernel))) return null;
    const now = kernel.clock.now().getTime();
    await check("members", now);
    await check("channels", now);
    const mine = await kernel.execute("slack.take_owner", {}, you);
    if (mine.status !== "ok") log(`taking your Slack DM failed: ${JSON.stringify(mine)}`);
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
