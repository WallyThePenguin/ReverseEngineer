// The mail sync's cursor, as kept on the account: the provider's own, plus what's left to do
// (D55) and the mail that failed, parked beside the queue (6.2).

/** A message that failed, waiting beside the queue: when it's tried again, and if it's old mail. */
export interface Parked {
  at: number;
  quiet?: true;
}

/** The cursor as the sync keeps it: the provider's own, plus what's left to do. */
export interface SyncCursor {
  provider: Record<string, unknown>;
  /** New mail still to fetch. */
  pending: string[];
  /** Mail that failed, by provider id: tried again after the queue, once it's due. */
  parked: Record<string, Parked>;
  /** Messages Hearth has whose flags changed, still to look up. */
  relabel: string[];
  /** What's pending is old mail from a first sync, not news. */
  quiet: boolean;
  /** A first sync's progress: messages listed so far, and about how many there are. */
  backfill?: { listed: number; target: number };
  /** When a sync last looked for set-aside mail due another try. */
  lookedAside: number;
}

const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

function parkedIn(v: unknown): Record<string, Parked> {
  if (!v || typeof v !== "object") return {};
  return Object.fromEntries(
    Object.entries(v as Record<string, Parked>).filter(([, p]) => typeof p?.at === "number"),
  );
}

export function readCursor(raw: Record<string, unknown> | null): SyncCursor {
  const { pending, parked, relabel, quiet, backfill, lookedAside, ...provider } = raw ?? {};
  const b = backfill as SyncCursor["backfill"] | undefined;
  return {
    provider,
    pending: ids(pending),
    parked: parkedIn(parked),
    relabel: ids(relabel),
    quiet: quiet === true,
    ...(b && typeof b.listed === "number" ? { backfill: b } : {}),
    lookedAside: typeof lookedAside === "number" ? lookedAside : 0,
  };
}

export function writeCursor(c: SyncCursor): Record<string, unknown> {
  const left = c.pending.length + c.relabel.length > 0;
  return {
    ...c.provider,
    ...(c.pending.length ? { pending: c.pending } : {}),
    ...(Object.keys(c.parked).length ? { parked: c.parked } : {}),
    ...(c.relabel.length ? { relabel: c.relabel } : {}),
    ...(left && c.quiet ? { quiet: true } : {}),
    ...(c.backfill && (left || "pageToken" in c.provider) ? { backfill: c.backfill } : {}),
    ...(c.lookedAside ? { lookedAside: c.lookedAside } : {}),
  };
}
