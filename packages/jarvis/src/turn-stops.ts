// How running turns are stopped: by the owner pressing Stop (D54), or because Jarvis itself is
// stopping for a restart or an update (D62). Either way the turn's signal fires, so the brain is
// let go and no further tool runs (turn-budget.ts). Only the reason differs: nobody pressed Stop
// on a turn Jarvis's own stop cut short, so it isn't recorded as stopped. It's left running for
// the next start, which says Jarvis restarted (recoverInterrupted).
import type { BrainTool } from "./brain.ts";

/** What a turn's signal says when Jarvis is stopping, rather than the owner. */
export const STOPPING = new DOMException("Jarvis is stopping.", "AbortError");

export class TurnStops {
  private readonly aborts = new Map<string, AbortController>();
  private readonly running = new Set<Promise<unknown>>();
  private stopping = false;

  /** A turn starts: its Stop, already pulled if Jarvis is stopping (a claim can race the stop). */
  start(turnId: string): AbortController {
    const stop = new AbortController();
    if (this.stopping) stop.abort(STOPPING);
    this.aborts.set(turnId, stop);
    return stop;
  }

  end(turnId: string): void {
    this.aborts.delete(turnId);
  }

  /** The owner pressed Stop. False when the turn isn't running here. */
  cancel(turnId: string): boolean {
    const a = this.aborts.get(turnId);
    a?.abort();
    return Boolean(a);
  }

  /** Backs up the owner's Stop signal with what the turn's row says (`requested`). */
  watch(stop: AbortController, requested: () => Promise<boolean>, everyMs: number) {
    const timer = setInterval(() => {
      void requested().then((yes) => {
        if (yes) stop.abort();
      });
    }, everyMs);
    timer.unref();
    return timer;
  }

  /** Jarvis is stopping: every running turn ends now, and any claimed after this never starts. */
  interruptAll(): void {
    this.stopping = true;
    for (const a of this.aborts.values()) a.abort(STOPPING);
  }

  /** Whether a turn ended because Jarvis is stopping (and not because the owner pressed Stop). */
  static byJarvis(stop: AbortController): boolean {
    return stop.signal.reason === STOPPING;
  }

  /** A turn's tools, each run kept count of until it's done. */
  track(tools: BrainTool[]): BrainTool[] {
    return tools.map((t) => ({
      ...t,
      run: (input: unknown) => {
        const run = t.run(input);
        const done = () => void this.running.delete(run);
        this.running.add(run);
        run.then(done, done);
        return run;
      },
    }));
  }

  /**
   * Waits, up to `ms`, for tools still running when their turns ended. The turn lets go of a
   * tool once its signal fires, but the tool itself carries on: a stopping Jarvis lets a send or
   * a write finish rather than cut it off by closing the database under it.
   */
  async settled(ms: number): Promise<void> {
    if (this.running.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    await Promise.race([Promise.allSettled([...this.running]), late]);
    clearTimeout(timer);
  }
}
