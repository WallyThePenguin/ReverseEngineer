// Opening Chrome when Jarvis needs it and it's closed (D28), for the browser bridge: one try at a
// time, a moment for a running Chrome to reconnect first, and a pause after a failed try so page
// checks don't start Chrome every minute. You pressing Open Chrome skips both waits.
import { ActionError } from "@hearth/kernel";
import { OFFLINE_MESSAGE } from "@hearth/modules";
import type { ChromeLauncher } from "./launch.ts";

export interface OpenTiming {
  /** After Hearth starts, how long a running Chrome gets to reconnect before another is opened. */
  startGraceMs: number;
  /** After the link drops, how long Chrome gets to come back by itself. */
  dropGraceMs: number;
  /** How long Chrome gets to connect once it's been asked to start. */
  connectMs: number;
  /** After a try fails, how long before Hearth tries again by itself. You can try any time. */
  retryMs: number;
  /**
   * A Chrome that drops its link this soon after Hearth opened it was closed at once: by you, or
   * by itself because background apps are off. Either way, Hearth leaves it closed for a while.
   */
  quitMs: number;
  /**
   * After a hello with an earlier pairing code, how long a paired extension still gets to connect:
   * the old code may be in another Chrome profile, not the one Hearth opened.
   */
  oldCodeMs: number;
}

export const OPEN_TIMING: OpenTiming = {
  startGraceMs: 30_000,
  dropGraceMs: 10_000,
  connectMs: 45_000,
  retryMs: 5 * 60_000,
  quitMs: 10_000,
  oldCodeMs: 5_000,
};

export const NOT_PAIRED = "Chrome isn't paired with Hearth yet. Pair it in Settings → Chrome.";
export const OLD_CODE =
  "Chrome opened, but the Hearth extension in it has an old pairing code. Pair it again in Settings → Chrome.";
export const CLOSED_AT_ONCE =
  "Chrome closed right after Hearth opened it, so Hearth won't open it again by itself for a few minutes. If you didn't close it, turn on \"Continue running background apps when Google Chrome is closed\" in Chrome's settings (chrome://settings/system).";
const STOPPING = "Hearth is stopping.";

export interface OpenerDeps {
  launcher: ChromeLauncher | null;
  timing?: Partial<OpenTiming>;
  /** Whether an extension has been paired at all. Without one, opening Chrome can't help. */
  isPaired: () => Promise<boolean>;
  /** Whether the extension is connected right now. */
  isConnected: () => boolean;
  /** Called whenever what state() returns changes. */
  changed: () => void;
}

export class ChromeOpener {
  private readonly deps: OpenerDeps;
  private readonly timing: OpenTiming;
  private readonly startedAt = Date.now();
  private droppedAt = 0;
  private launchedAt = 0;
  private opening: Promise<void> | null = null;
  /** You asked to open Chrome now: skip the wait for a running Chrome to reconnect. */
  private hurry = false;
  private turnedAway = false;
  private stopped = false;
  private failure: { message: string; at: number } | null = null;
  /** Wakes everything waiting for Chrome: on connect, on a turned-away hello, or when you ask. */
  private readonly wakers = new Set<() => void>();

  constructor(deps: OpenerDeps) {
    this.deps = deps;
    this.timing = { ...OPEN_TIMING, ...deps.timing };
  }

  state() {
    return {
      canOpen: this.deps.launcher !== null,
      opening: this.opening !== null,
      openError: this.failure?.message ?? null,
    };
  }

  /** The extension connected. */
  connected(): void {
    this.failure = null;
    this.wake();
  }

  /** The extension's link dropped. Right after Hearth opened Chrome, that means Chrome closed. */
  dropped(): void {
    const now = Date.now();
    this.droppedAt = now;
    if (this.launchedAt && now - this.launchedAt < this.timing.quitMs) this.fail(CLOSED_AT_ONCE);
    this.launchedAt = 0;
  }

  /** Pairing changed, so earlier failures no longer say anything; Hearth may try again at once. */
  pairingChanged(): void {
    this.failure = null;
    this.launchedAt = 0;
  }

  /** An extension's hello was turned away: its pairing code is old. */
  turnedAwayHello(): void {
    this.turnedAway = true;
    this.wake();
  }

  /** Hearth is stopping: everything waiting gives up now. */
  stop(): void {
    this.stopped = true;
    this.wake();
  }

  /**
   * Makes sure Chrome is connected, opening it if it's closed. `now` (you pressed Open Chrome)
   * skips the reconnect wait and the pause after a failed try.
   */
  async open(opts: { now?: boolean } = {}): Promise<void> {
    const { launcher } = this.deps;
    if (this.deps.isConnected()) return;
    if (!launcher) throw new ActionError("unavailable", OFFLINE_MESSAGE);
    if (this.stopped) throw new ActionError("unavailable", STOPPING);
    const recent = this.failure && Date.now() - this.failure.at < this.timing.retryMs;
    if (recent && !opts.now && !this.opening)
      throw new ActionError("unavailable", this.failure?.message ?? OFFLINE_MESSAGE);
    if (opts.now) this.hurry = true;
    if (!this.opening) {
      this.opening = this.tryOpen(launcher).finally(() => {
        this.opening = null;
        this.hurry = false;
        this.deps.changed();
      });
      this.deps.changed();
    } else if (opts.now) this.wake();
    return this.opening;
  }

  private async tryOpen(launcher: ChromeLauncher): Promise<void> {
    if (!(await this.deps.isPaired())) throw this.fail(NOT_PAIRED);
    const now = Date.now();
    const grace = Math.max(
      this.startedAt + this.timing.startGraceMs - now,
      this.droppedAt + this.timing.dropGraceMs - now,
    );
    if (!this.hurry && grace > 0) await this.waitFor(grace, () => this.hurry);
    if (this.stopped) throw new ActionError("unavailable", STOPPING);
    if (this.deps.isConnected()) return;
    try {
      await launcher.open();
    } catch (err) {
      throw this.fail(err instanceof Error ? err.message : String(err));
    }
    const launched = Date.now();
    this.launchedAt = launched;
    this.turnedAway = false;
    const deadline = launched + this.timing.connectMs;
    await this.waitFor(this.timing.connectMs, () => this.turnedAway);
    if (this.turnedAway && !this.deps.isConnected() && !this.stopped)
      await this.waitFor(Math.min(this.timing.oldCodeMs, deadline - Date.now()), () => false);
    if (this.deps.isConnected()) return;
    if (this.stopped) throw new ActionError("unavailable", STOPPING);
    this.launchedAt = 0;
    if (this.turnedAway) throw this.fail(OLD_CODE);
    // It connected and quit again already.
    if (this.failure && this.failure.at >= launched)
      throw new ActionError("unavailable", this.failure.message);
    const seconds = Math.round(this.timing.connectMs / 1000);
    throw this.fail(
      [
        `Hearth started Chrome, but the Hearth extension didn't connect within ${seconds} seconds.`,
        launcher.hint,
        'Check that the extension is installed and paired in that Chrome profile, and that Chrome\'s "Continue running background apps" setting is on.',
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  private fail(message: string): ActionError {
    this.failure = { message, at: Date.now() };
    this.deps.changed();
    return new ActionError("unavailable", message);
  }

  /** Waits up to `ms` for Chrome to connect, for Hearth to stop, or for `enough()`. */
  private waitFor(ms: number, enough: () => boolean): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        if (!this.deps.isConnected() && !this.stopped && !enough()) return;
        clearTimeout(timer);
        this.wakers.delete(done);
        resolve();
      };
      const timer = setTimeout(() => {
        this.wakers.delete(done);
        resolve();
      }, ms);
      this.wakers.add(done);
      done();
    });
  }

  private wake(): void {
    for (const waker of [...this.wakers]) waker();
  }
}
