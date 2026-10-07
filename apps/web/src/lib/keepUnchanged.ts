// A read that comes back keeps what didn't change as it was. Solid's query library turns off
// TanStack's own sharing (every read again is all new objects), and a list's <For> knows its rows
// by object, so every refresh drew every row again: an open menu closed, a row blinked, a tap
// could land on a button being replaced. With this, a row that didn't change is the same object,
// wherever it moved to (a new one above it, one gone), and only rows that changed are drawn again.

const plain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype;

/** `next`, with every part that's the same as in `old` (as JSON) kept as `old`'s object. */
export function keepUnchanged<T>(old: unknown, next: T): T {
  if (old === next) return next;
  if (Array.isArray(old) && Array.isArray(next)) {
    // Items by what they hold, not where they were: each of old's is kept for one of next's.
    const unused = new Map<string, unknown[]>();
    for (const o of old) {
      const k = JSON.stringify(o);
      unused.set(k, [...(unused.get(k) ?? []), o]);
    }
    let same = old.length === next.length;
    const out = next.map((n, i) => {
      const kept = unused.get(JSON.stringify(n))?.shift();
      if (kept !== old[i]) same = false;
      return kept === undefined ? n : kept;
    });
    return (same ? old : out) as T;
  }
  if (plain(old) && plain(next)) {
    let same = Object.keys(old).length === Object.keys(next).length;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(next)) {
      out[k] = keepUnchanged(old[k], v);
      if (out[k] !== old[k]) same = false;
    }
    return (same ? old : out) as T;
  }
  return next;
}
