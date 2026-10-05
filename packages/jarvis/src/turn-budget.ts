// How much one turn may do. Time goes by lane (D54). Work in a browser takes many small steps
// (read the page, click, read it again), so a turn that uses the browser gets more of both
// (B1, 1.16): once it takes its first browser step, the browser's time limit counted from the
// turn's start, and up to 150 model steps over as many goes as that takes. A turn that runs out
// of steps anyway isn't a failure: it stops with what it said so far and offers to carry on.
import { conversation } from "@hearth/db";
import type { Kernel } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import type { BrainRequest, BrainResult, BrainTool } from "./brain.ts";

/**
 * How long a turn may run before it's stopped: by lane, for a voice command (the owner is
 * waiting on it), for a turn that uses the browser (D54, B1), and for a Slack member's (D62).
 */
export const TURN_LIMIT_MS = {
  fast: 10 * 60_000,
  deep: 30 * 60_000,
  voice: 2 * 60_000,
  browser: 30 * 60_000,
  /** A Slack member's turn: two minutes, and MEMBER_STEPS model steps (D62). */
  member: 2 * 60_000,
};

/** Model steps a Slack member's turn may take (D62). */
export const MEMBER_STEPS = 8;

/** Model steps a turn that uses the browser may take in all, across its goes. */
export const BROWSER_STEPS = 150;

/** What the model is told when a browsing turn gets more steps. */
export const CARRY_ON =
  "You ran out of steps for one go and have been given more. Carry on with the task from where you left off.";

/** What a tool says once its turn has been stopped or run out of time. */
export const ENDED = "Not run: this turn has been stopped. Don't call any more tools.";

/** What the owner reads when a turn runs out of steps. */
export const OUT_OF_STEPS =
  'I ran out of steps before finishing this. Say "continue" and I\'ll pick up where I left off.';

/**
 * When a turn has to end: when the owner stops it, or when its time is up. Its time moves later
 * once it starts using the browser.
 */
export class Deadline {
  /** Aborts when the turn is stopped or out of time. */
  readonly signal: AbortSignal;
  limitMs: number;
  private readonly browserMs: number;
  private readonly timeout = new AbortController();
  private readonly started = performance.now();
  private timer: NodeJS.Timeout;

  constructor(limitMs: number, browserMs: number, stop: AbortSignal) {
    this.limitMs = limitMs;
    this.browserMs = browserMs;
    this.signal = AbortSignal.any([stop, this.timeout.signal]);
    this.timer = this.arm();
  }

  /** The turn started using the browser: it gets the browser's time from its start, if longer. */
  browsing(): void {
    if (this.browserMs <= this.limitMs || this.signal.aborted) return;
    clearTimeout(this.timer);
    this.limitMs = this.browserMs;
    this.timer = this.arm();
  }

  clear(): void {
    clearTimeout(this.timer);
  }

  private arm(): NodeJS.Timeout {
    const left = Math.max(0, this.limitMs - (performance.now() - this.started));
    const timer = setTimeout(
      () => this.timeout.abort(new DOMException("The turn ran out of time.", "TimeoutError")),
      left,
    );
    timer.unref();
    return timer;
  }
}

/**
 * A turn's tools, held to its deadline: none runs once the turn is stopped or out of time (they
 * say `ended` instead, whatever the brain goes on to ask), and a browser tool gives the turn the
 * browser's time.
 */
export function bounded(tools: BrainTool[], deadline: Deadline, ended: string): BrainTool[] {
  return tools.map((t) => ({
    ...t,
    run: (input: unknown) => {
      if (deadline.signal.aborted) return Promise.resolve(ended);
      if (t.name.startsWith("browser_")) deadline.browsing();
      return t.run(input);
    },
  }));
}

/**
 * Runs a turn's brain until the turn is stopped or out of time, whether or not the brain notices.
 * Once it is, the brain isn't started at all: Stop can land while the turn is still being set up
 * (or between tries), and a model call started then would only be thrown away (D54).
 */
export function untilEnded<T>(signal: AbortSignal, start: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const ended = () => reject(signal.reason);
    signal.addEventListener("abort", ended, { once: true });
    start()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", ended));
  });
}

/** Whether a turn has used the browser, from the Hearth tools it ran. */
export const browsed = (calls: { action: string }[]): boolean =>
  calls.some((c) => c.action.startsWith("browser."));

/** Keeps a conversation's agent session, so its next turn resumes it. */
export async function keepSession(kernel: Kernel, cid: string, sessionId: string): Promise<void> {
  await kernel.db
    .update(conversation)
    .set({ agentSessionId: sessionId })
    .where(eq(conversation.entityId, cid));
}

/**
 * Thinks, and while a turn that has used the browser (its `calls` so far) runs out of steps short
 * of BROWSER_STEPS, gives it more by resuming its session. Each go's session is kept as it ends,
 * so a "continue" from the owner picks up from the last one even if a later go fails.
 */
export async function thinkOn(
  request: BrainRequest,
  think: (req: BrainRequest) => Promise<BrainResult>,
  calls: { action: string }[],
  keep: (sessionId: string) => Promise<void>,
): Promise<BrainResult> {
  let result = await think(request);
  let steps = 0;
  for (;;) {
    if (result.sessionId) await keep(result.sessionId);
    if (!result.outOfSteps) return result;
    steps += result.outOfSteps.steps;
    if (!browsed(calls) || steps >= BROWSER_STEPS || request.signal.aborted) return result;
    result = await think({
      ...request,
      prompt: CARRY_ON,
      sessionId: result.sessionId ?? request.sessionId,
      maxTurns: BROWSER_STEPS - steps,
    });
  }
}

/** A turn's reply; one that ran out of steps adds the offer to carry on to what it said last. */
export function replyOf(result: BrainResult): string {
  const said = result.text.trim();
  if (!result.outOfSteps) return said;
  return said ? `${said}\n\n${OUT_OF_STEPS}` : OUT_OF_STEPS;
}
