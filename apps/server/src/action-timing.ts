// How long the app's actions take on this server, so "slow" has a number (in /api/health/deep):
// per action, how many ran and how long the recent ones took. Names and times only, never what was
// asked or answered; kept in memory, so it starts over when the server does.

/** Recent runs kept per action: enough for a steady 95th percentile, little memory. */
const KEEP = 200;

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

  record(name: string, ms: number): void {
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
}

/** The nearest-rank percentile of sorted values: the smallest at or above that share of them. */
function rank(sorted: number[], q: number): number {
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0;
}
