// A doc's history (PLAN.md section 8.5): Loro keeps every edit, so versions are points in the
// doc's own log, grouped into sessions of editing, plus the checkpoints you name. Scrubbing
// reads the doc at a version; restoring writes that text back as a new edit, so nothing is lost.
import { type DbOrTx, docCheckpoint, docPeer, type Frontiers } from "@hearth/db";
import { asc, eq } from "drizzle-orm";
import { type LoroDoc, VersionVector } from "loro-crdt";
import { z } from "zod";

/** Edits further apart than this are separate versions. */
const SESSION_GAP_S = 10 * 60;
/** Versions listed, newest first. */
const MAX_VERSIONS = 200;

export const frontiersInput = z
  .array(z.object({ peer: z.string().regex(/^\d{1,20}$/), counter: z.number().int().min(0) }))
  .min(1)
  .max(500);

export interface Version {
  /** When its last edit was made (ISO), or null for edits from before times were kept. */
  at: string | null;
  /** Who wrote its edits: principals, "someone" when unknown. */
  by: string[];
  frontiers: Frontiers;
}

/** Who each of the doc's peers wrote as. */
export async function peersOf(db: DbOrTx, id: string): Promise<Map<string, string>> {
  const rows = await db.select().from(docPeer).where(eq(docPeer.entityId, id));
  return new Map(rows.map((r) => [r.peer, r.principal]));
}

/** The doc's versions, newest first: one per stretch of editing. */
export function versions(doc: LoroDoc, peers: Map<string, string>): Version[] {
  const changes = [...doc.getAllChanges().values()]
    .flat()
    .sort((a, b) => a.lamport - b.lamport || a.peer.localeCompare(b.peer));
  const seen = new Map<`${number}`, number>();
  const out: Version[] = [];
  let group: { last: number; by: Set<string> } | null = null;
  const close = () => {
    if (!group) return;
    out.push({
      at: group.last ? new Date(group.last * 1000).toISOString() : null,
      by: [...group.by],
      frontiers: doc.vvToFrontiers(VersionVector.parseJSON(new Map(seen))),
    });
  };
  for (const c of changes) {
    if (group && c.timestamp - group.last > SESSION_GAP_S) {
      close();
      group = null;
    }
    group ??= { last: c.timestamp, by: new Set() };
    group.last = Math.max(group.last, c.timestamp);
    group.by.add(peers.get(c.peer) ?? "someone");
    seen.set(c.peer, Math.max(seen.get(c.peer) ?? 0, c.counter + c.length));
  }
  close();
  return out.reverse().slice(0, MAX_VERSIONS);
}

/** The text at a version, or null if the doc has no such version. */
export function textAt(doc: LoroDoc, frontiers: Frontiers): string | null {
  try {
    return doc
      .forkAt(frontiers as Parameters<LoroDoc["forkAt"]>[0])
      .getText("body")
      .toString();
  } catch {
    return null;
  }
}

export async function checkpointsOf(db: DbOrTx, id: string) {
  return db
    .select({
      id: docCheckpoint.id,
      name: docCheckpoint.name,
      frontiers: docCheckpoint.frontiers,
      createdBy: docCheckpoint.createdBy,
      createdAt: docCheckpoint.createdAt,
    })
    .from(docCheckpoint)
    .where(eq(docCheckpoint.entityId, id))
    .orderBy(asc(docCheckpoint.createdAt));
}
