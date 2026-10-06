// How long the app's actions take on this server, so "slow" has a number (in /api/health/deep):
// per action, how many ran and how long the recent ones took. Names and times only, never what was
// asked or answered; kept in memory, so it starts over when the server does. What a restart would
// lose goes to the server's log (server.jsonl) too: each run over a second as it happens, and the
// whole table when the server stops.

/** Recent runs kept per action: enough for a steady 95th percentile, little memory. */
const KEEP = 200;
/** A run this long is written to the log as it happens. */
export const SLOW_MS = 1_000;

export interface ActionTiming {
  name: string;
  /** Runs since the server started. */
  count: number;
  /** Over the recent runs, in ms. */
  p50: number;
  p95: number;
  max: number;
}

export class ActionTimings {
  readonly #byName = new Map<string, { count: number; recent: number[] }>();

  readonly #log: (line: string) => void;

  /** `log`: where slow runs and the table go; the console, which the server keeps in server.jsonl. */
  constructor(log: (line: string) => void = (line) => console.warn(line)) {
    this.#log = log;
  }

  record(name: string, ms: number): void {
    if (ms >= SLOW_MS) this.#log(`Slow action: ${name} took ${Math.round(ms)} ms`);
    const t = this.#byName.get(name) ?? { count: 0, recent: [] };
    // A ring: run n lands in slot n % KEEP.
    t.recent[t.count % KEEP] = ms;
    t.count++;
    this.#byName.set(name, t);
  }

  /** The slowest actions first, by their 95th percentile. */
  slowest(limit = 12): ActionTiming[] {
    return [...this.#byName]
      .map(([name, t]) => {
        const sorted = [...t.recent].sort((a, b) => a - b);
        return {
          name,
          count: t.count,
          p50: Math.round(rank(sorted, 0.5)),
          p95: Math.round(rank(sorted, 0.95)),
          max: Math.round(sorted.at(-1) ?? 0),
        };
      })
      .sort((a, b) => b.p95 - a.p95 || b.count - a.count)
      .slice(0, limit);
  }

  /** Writes the table to the log, as the server stops: a restart doesn't wipe the evidence. */
  report(): void {
    const all = this.slowest(Number.POSITIVE_INFINITY);
    if (!all.length) return;
    const rows = all.map((a) => `${a.name} ×${a.count} p50 ${a.p50} p95 ${a.p95} max ${a.max}`);
    this.#log(`Action times since the server started (ms): ${rows.join("; ")}`);
  }
}

/** The nearest-rank percentile of sorted values: the smallest at or above that share of them. */
function rank(sorted: number[], q: number): number {
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0;
}
