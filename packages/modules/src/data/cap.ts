// What a data source sends back, made small enough for Jarvis to read (D73): long strings cut,
// and a result past the byte cap cut short.

/** How deep a value is walked before what's under it is left out. */
const DEPTH = 32;

export function capValue(
  value: unknown,
  limits: { cell: number; bytes: number },
): { value: unknown; truncated: boolean } {
  let truncated = false;
  const cut = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") {
      if (v.length <= limits.cell) return v;
      truncated = true;
      return `${v.slice(0, limits.cell)}…`;
    }
    if (v === null || typeof v !== "object") return v;
    if (depth >= DEPTH) {
      truncated = true;
      return "…";
    }
    if (Array.isArray(v)) return v.map((x) => cut(x, depth + 1));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cut(x, depth + 1)]));
  };
  const out = cut(value, 0);
  const size = (v: unknown) => (JSON.stringify(v) ?? "").length;
  if (size(out) <= limits.bytes) return { value: out, truncated };
  // A list keeps what fits from its start; anything else comes back as its JSON, cut.
  if (!Array.isArray(out))
    return { value: `${JSON.stringify(out).slice(0, limits.bytes)}…`, truncated: true };
  const kept: unknown[] = [];
  let used = 2;
  for (const item of out) {
    used += size(item) + 1;
    if (used > limits.bytes) break;
    kept.push(item);
  }
  return { value: kept, truncated: true };
}
