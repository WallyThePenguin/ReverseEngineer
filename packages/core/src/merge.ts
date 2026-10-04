// Three-way merges for what's saved whole (D59). When a board or a workbook is saved over a
// newer version than the one it was edited from (Jarvis added cards, another screen typed in a
// cell), the screen takes the newer one and puts its own changes on top, piece by piece: a
// board's cards and arrows by id, a workbook's sheets by id and their cells by name. A piece only
// one side changed takes that side; a piece both changed takes this screen's.
import type { Canvas } from "./canvas.ts";
import type { Workbook, Worksheet } from "./sheet.ts";

/** JSON with keys sorted, so the same value reads the same whichever side built it. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );
const same = (a: unknown, b: unknown) => a === b || canonical(a) === canonical(b);

/**
 * One piece: what it was (`base`), what this screen has (`mine`), what was saved (`theirs`);
 * undefined where it doesn't exist. Deleting beats an unchanged piece, never a changed one.
 */
function pick<T>(base: T | undefined, mine: T | undefined, theirs: T | undefined) {
  if (same(mine, base)) return theirs;
  if (mine === undefined) return same(theirs, base) ? undefined : theirs;
  return mine;
}

/** Merges values by key, keeping theirs where this screen changed nothing. */
export function mergeRecord<V>(
  base: Record<string, V>,
  mine: Record<string, V>,
  theirs: Record<string, V>,
): Record<string, V> {
  const out: Record<string, V> = { ...theirs };
  for (const k of new Set([...Object.keys(base), ...Object.keys(mine)])) {
    const v = pick(base[k], mine[k], theirs[k]);
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** Merges lists of things with ids, in theirs' order, then this screen's new ones. */
export function mergeById<T extends { id: string }>(
  base: T[],
  mine: T[],
  theirs: T[],
  merge: (b: T | undefined, m: T | undefined, t: T | undefined) => T | undefined = pick,
): T[] {
  const byId = (list: T[]) => new Map(list.map((x) => [x.id, x]));
  const [b, m, t] = [byId(base), byId(mine), byId(theirs)];
  const order = [...t.keys(), ...[...m.keys()].filter((id) => !t.has(id))];
  const out: T[] = [];
  for (const id of order) {
    const v = merge(b.get(id), m.get(id), t.get(id));
    if (v !== undefined) out.push(v);
  }
  return out;
}

/** A board with this screen's changes put on top of the one saved since. */
export function mergeCanvas(base: Canvas, mine: Canvas, theirs: Canvas): Canvas {
  const nodes = mergeById(base.nodes, mine.nodes, theirs.nodes);
  const ids = new Set(nodes.map((n) => n.id));
  const tied = (e: Canvas["edges"][number]) =>
    (e.from.type !== "connected" || ids.has(e.from.node)) &&
    (e.to.type !== "connected" || ids.has(e.to.node));
  return { nodes, edges: mergeById(base.edges, mine.edges, theirs.edges).filter(tied) };
}

function mergeSheet(
  b: Worksheet | undefined,
  m: Worksheet | undefined,
  t: Worksheet | undefined,
): Worksheet | undefined {
  if (!m || !t) return pick(b, m, t);
  const from = b ?? { ...t, cells: {}, widths: {} };
  return {
    ...t,
    name: same(m.name, from.name) ? t.name : m.name,
    cells: mergeRecord(from.cells, m.cells, t.cells),
    widths: mergeRecord(from.widths, m.widths, t.widths),
  };
}

/** A workbook with this screen's changes put on top of the one saved since. */
export function mergeWorkbook(base: Workbook, mine: Workbook, theirs: Workbook): Workbook {
  const sheets = mergeById(base.sheets, mine.sheets, theirs.sheets, mergeSheet).map((s) => ({
    ...s,
  }));
  // Two sheets added on both sides with the same name: the later one gets a number.
  const taken = new Set<string>();
  for (const s of sheets) {
    let name = s.name;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${s.name.slice(0, 27)} (${n})`;
    s.name = name;
    taken.add(name.toLowerCase());
  }
  return { sheets: sheets.length ? sheets : theirs.sheets };
}
