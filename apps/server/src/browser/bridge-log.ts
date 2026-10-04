// What happened on the link to Chrome, for the Chrome settings and health (D52): connects, drops,
// refusals and failed calls with how long they took, the last 200 of them, and counts of the
// calls since Hearth started. In memory only; it starts over when Hearth restarts.

export type BridgeLogKind = "connect" | "disconnect" | "replaced" | "reject" | "error" | "timeout";

export interface BridgeLogEntry {
  at: string;
  kind: BridgeLogKind;
  message: string;
  /** The request, like "cdp Page.navigate" or "tabs.open". */
  method?: string;
  /** How long it took, for a call. */
  ms?: number;
}

export interface BridgeStats {
  calls: number;
  failed: number;
  /** Average time to an answer, in milliseconds, or null before any. */
  averageMs: number | null;
  slowestMs: number | null;
}

const MAX_ENTRIES = 200;

export class BridgeLog {
  private readonly entries: BridgeLogEntry[] = [];
  private calls = 0;
  private failed = 0;
  private totalMs = 0;
  private slowestMs = 0;
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  add(kind: BridgeLogKind, message: string, extra: { method?: string; ms?: number } = {}): void {
    this.entries.push({ at: this.now().toISOString(), kind, message, ...extra });
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
  }

  /** A call Chrome answered, after `ms`. */
  called(ms: number, failed: boolean): void {
    this.calls++;
    if (failed) this.failed++;
    this.totalMs += ms;
    this.slowestMs = Math.max(this.slowestMs, ms);
  }

  /** The newest first. */
  recent(limit = MAX_ENTRIES): BridgeLogEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  stats(): BridgeStats {
    return {
      calls: this.calls,
      failed: this.failed,
      averageMs: this.calls ? Math.round(this.totalMs / this.calls) : null,
      slowestMs: this.calls ? this.slowestMs : null,
    };
  }
}
