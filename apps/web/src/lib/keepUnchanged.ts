// A read that comes back keeps what didn't change as it was. Solid's query library turns off
// TanStack's own sharing (every read again is all new objects), and a list's <For> knows its rows
// by object, so every refresh drew every row again: an open menu closed, a row blinked, a tap
// could land on a button being replaced. With this, a row that didn't change is the same object,
// wherever it moved to (a new one above it, one gone), and only rows that changed are drawn again.
// What's compared is plain JSON from Hearth's API, so comparing as JSON is exact for it.

const plain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype;

/** As JSON, or null for what JSON can't hold (a BigInt): that's never taken as unchanged. */
function json(v: unknown): string | null {
  try {
    return JSON.stringify(v) ?? null;
  } catch {
    return null;
  }
}

/** `next`, with every part that's the same as in `old` (as JSON) kept as `old`'s object. */
export function keepUnchanged<T>(old: unknown, next: T): T {
  if (old === next) return next;
  if (Array.isArray(old) && Array.isArray(next)) return keepItems(old, next) as T;
  if (plain(old) && plain(next)) {
    let same = Object.keys(old).length === Object.keys(next).length;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(next)) {
      out[k] = keepUnchanged(old[k], v);
      if (!(k in old) || out[k] !== old[k]) same = false;
    }
    return (same ? old : out) as T;
  }
  return next;
}

/** Adds `i` to `key`'s list in `m`. */
function add<K>(m: Map<K, number[]>, key: K, i: number) {
  const list = m.get(key);
  if (list) list.push(i);
  else m.set(key, [i]);
}

function keepItems(old: readonly unknown[], next: readonly unknown[]): readonly unknown[] {
  const byJson = new Map<string, number[]>();
  old.forEach((o, i) => {
    const k = json(o);
    if (k !== null) add(byJson, k, i);
  });
  const used = new Set<number>();
  // First what's the same as before, wherever it was: each of old's is kept for one of next's.
  const same = next.map((n) => {
    const k = json(n);
    const i = k === null ? undefined : byJson.get(k)?.shift();
    if (i !== undefined) used.add(i);
    return i;
  });
  // Then what changed, against what it was: a page of a list read a page at a time keeps its
  // unchanged rows, and a changed row its unchanged parts.
  let byId: Map<unknown, number[]> | null = null;
  const was = (n: unknown, at: number): number | undefined => {
    if (plain(n) && n.id != null) {
      // A row with an id was the old row with that id, wherever it was; none, and it's new. Rows
      // with no id (or a null one) aren't indexed: they go by place, below.
      byId ??= old.reduce<Map<unknown, number[]>>((m, o, i) => {
        if (plain(o) && o.id != null) add(m, o.id, i);
        return m;
      }, new Map());
      return byId.get(n.id)?.find((i) => !used.has(i));
    }
    const o = old[at];
    const alike = (Array.isArray(o) && Array.isArray(n)) || (plain(o) && plain(n));
    return at < old.length && !used.has(at) && alike ? at : undefined;
  };
  const out = next.map((n, at) => {
    const kept = same[at];
    if (kept !== undefined) return old[kept];
    const i = was(n, at);
    if (i === undefined) return n;
    used.add(i);
    return keepUnchanged(old[i], n);
  });
  return out.length === old.length && out.every((o, i) => o === old[i]) ? old : out;
}
