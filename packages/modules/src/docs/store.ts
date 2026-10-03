// Docs as Loro CRDTs (PLAN.md section 8.5): a note's text is a LoroText every screen edits and
// merges, with the body column kept as the readable copy. Anything that writes the body directly
// (Jarvis, the checklist) is taken into the doc as an edit the next time it's opened, so it merges
// with typing instead of overwriting it.

import { randomBytes } from "node:crypto";
import { type DbOrTx, docPeer, docState, docUpdate, entity } from "@hearth/db";
import { type ActionContext, type EntityRow, updateEntity } from "@hearth/kernel";
import { and, asc, eq, gt, lte, max } from "drizzle-orm";
import { LoroDoc, type LoroText, type VersionVector } from "loro-crdt";

/**
 * A record type whose text is a live doc: how long its text may get, and how a new text is
 * saved to the record (the memory module keeps its own versions, for one).
 */
export interface DocType {
  maxChars: number;
  write(ctx: ActionContext, id: string, body: string): Promise<number>;
}

/** Record types whose text is a live doc, by type. */
export const DOC_TYPES = new Map<string, DocType>([
  [
    "note",
    {
      maxChars: 200_000,
      write: async (ctx, id, body) => (await updateEntity(ctx, id, { body })).revision,
    },
  ],
]);

/** Makes another record type's text a live doc. */
export function registerDocType(type: string, spec: DocType) {
  DOC_TYPES.set(type, spec);
}
const TEXT = "body";
/** Updates kept before they're folded into the snapshot. */
const FOLD_AFTER = 50;

export const textOf = (doc: LoroDoc) => doc.getText(TEXT).toString();

function fresh(): LoroDoc {
  const doc = new LoroDoc();
  doc.setRecordTimestamp(true);
  return doc;
}

/**
 * Saves an update, and names who wrote it: each Loro peer whose edits it adds is recorded as
 * theirs, so history can say who changed what. The first claim on a peer stands.
 */
/** Each server-side edit gets its own peer, so it can be named as its writer's alone. */
function newPeer(doc: LoroDoc) {
  doc.setPeerId(randomBytes(8).readBigUInt64BE() & 0x7fff_ffff_ffff_ffffn);
}

async function append(
  ctx: ActionContext,
  id: string,
  doc: LoroDoc,
  before: VersionVector,
  by: string,
  data: Uint8Array = doc.export({ mode: "update", from: before }),
) {
  await ctx.tx.insert(docUpdate).values({ entityId: id, data: Buffer.from(data), createdBy: by });
  await recordPeers(ctx, id, doc, before, by);
}

async function recordPeers(
  ctx: ActionContext,
  id: string,
  doc: LoroDoc,
  before: VersionVector,
  by: string,
) {
  const was = before.toJSON() as Map<string, number>;
  const peers = [...(doc.oplogVersion().toJSON() as Map<string, number>)]
    .filter(([peer, n]) => n > (was.get(peer) ?? 0))
    .map(([peer]) => ({ entityId: id, peer, principal: by }));
  if (peers.length) await ctx.tx.insert(docPeer).values(peers).onConflictDoNothing();
}

/** The doc as stored, without taking anything in (for reading its history). */
export async function loadDoc(db: DbOrTx, id: string) {
  const [state] = await db.select().from(docState).where(eq(docState.entityId, id));
  if (!state) return null;
  const doc = fresh();
  doc.import(state.snapshot);
  const updates = await db
    .select({ data: docUpdate.data })
    .from(docUpdate)
    .where(and(eq(docUpdate.entityId, id), gt(docUpdate.seq, state.upto)))
    .orderBy(asc(docUpdate.seq));
  if (updates.length) doc.importBatch(updates.map((u) => u.data));
  return { doc, state, pending: updates.length };
}

/**
 * The doc for a record, locked by the caller. Made from the body the first time; if the body was
 * written directly since the doc last matched it, that write becomes an edit in the doc.
 */
export async function openDoc(
  ctx: ActionContext,
  row: EntityRow,
): Promise<{ doc: LoroDoc; pending: number }> {
  const loaded = await loadDoc(ctx.tx, row.id);
  if (!loaded) {
    const doc = fresh();
    const before = doc.oplogVersion();
    if (row.body) doc.getText(TEXT).insert(0, row.body);
    doc.commit();
    await ctx.tx.insert(docState).values({
      entityId: row.id,
      snapshot: Buffer.from(doc.export({ mode: "snapshot" })),
      revision: row.revision,
    });
    // The text it starts from is the last writer's if only one has written it.
    const by = row.createdBy === row.updatedBy ? row.updatedBy : "someone";
    await recordPeers(ctx, row.id, doc, before, by);
    return { doc, pending: 0 };
  }
  const { doc, state } = loaded;
  let pending = loaded.pending;
  if (state.revision !== row.revision) {
    const body = row.body ?? "";
    if (body !== textOf(doc)) {
      const before = doc.oplogVersion();
      newPeer(doc);
      doc.getText(TEXT).update(body);
      doc.commit();
      await append(ctx, row.id, doc, before, row.updatedBy);
      pending++;
    }
    await setRevision(ctx.tx, row.id, row.revision);
  }
  return { doc, pending };
}

/**
 * Takes a new text into a record's doc as the caller's own edit, before the record itself is
 * written, so history names who wrote what (a later rename can't claim an earlier change). Call
 * `done` with the record's new revision once it's saved. Does nothing for other records.
 */
export async function takeIntoDoc(
  ctx: ActionContext,
  id: string,
  body: string | undefined,
): Promise<{ done(revision: number): Promise<void> }> {
  const [row] = await ctx.tx.select().from(entity).where(eq(entity.id, id)).for("update");
  if (!row || row.deletedAt || !DOC_TYPES.has(row.type)) return { done: async () => {} };
  const { doc, pending } = await openDoc(ctx, row);
  const added =
    body !== undefined && body !== textOf(doc)
      ? await editAsCaller(ctx, id, doc, (t) => t.update(body))
      : false;
  return { done: (revision) => finish(ctx, id, revision, doc, pending + (added ? 1 : 0)) };
}

/** Makes an edit to the doc as the caller, and saves it. Returns whether it changed anything. */
export async function editAsCaller(
  ctx: ActionContext,
  id: string,
  doc: LoroDoc,
  change: (text: LoroText) => void,
): Promise<boolean> {
  const before = doc.oplogVersion();
  newPeer(doc);
  change(doc.getText(TEXT));
  doc.commit();
  if (doc.oplogVersion().compare(before) === 0) return false;
  await append(ctx, id, doc, before, ctx.caller.principal);
  return true;
}

/** After the record is saved with the doc's text: notes its revision, and folds if it's time. */
export async function finish(
  ctx: ActionContext,
  id: string,
  revision: number,
  doc: LoroDoc,
  pending: number,
) {
  await setRevision(ctx.tx, id, revision);
  await fold(ctx, id, doc, pending);
}

/** note.update: the title or body, written as the caller (see takeIntoDoc). */
export async function writeDoc(
  ctx: ActionContext,
  id: string,
  patch: { title?: string; body?: string },
  opts: { expectedRevision?: number; type: string },
): Promise<EntityRow> {
  const [row] = await ctx.tx.select().from(entity).where(eq(entity.id, id)).for("update");
  if (row && opts.expectedRevision !== undefined && opts.expectedRevision !== row.revision)
    return updateEntity(ctx, id, patch, opts); // Fails with the usual conflict.
  const step = await takeIntoDoc(ctx, id, patch.body);
  const out = await updateEntity(ctx, id, patch, opts);
  await step.done(out.revision);
  return out;
}

export async function setRevision(db: DbOrTx, id: string, revision: number) {
  await db.update(docState).set({ revision }).where(eq(docState.entityId, id));
}

/** Takes in an update from a screen. Returns whether it held anything new. */
export async function applyUpdate(
  ctx: ActionContext,
  id: string,
  doc: LoroDoc,
  data: Uint8Array,
): Promise<boolean> {
  const before = doc.oplogVersion();
  doc.import(data);
  if (Buffer.from(doc.oplogVersion().encode()).equals(Buffer.from(before.encode()))) return false;
  await append(ctx, id, doc, before, ctx.caller.principal, data);
  return true;
}

/** Folds the updates into the snapshot once there are enough of them. */
export async function fold(ctx: ActionContext, id: string, doc: LoroDoc, pending: number) {
  if (pending < FOLD_AFTER) return;
  const [last] = await ctx.tx
    .select({ seq: max(docUpdate.seq) })
    .from(docUpdate)
    .where(eq(docUpdate.entityId, id));
  if (!last?.seq) return;
  await ctx.tx
    .update(docState)
    .set({ snapshot: Buffer.from(doc.export({ mode: "snapshot" })), upto: last.seq })
    .where(eq(docState.entityId, id));
  await ctx.tx
    .delete(docUpdate)
    .where(and(eq(docUpdate.entityId, id), lte(docUpdate.seq, last.seq)));
}
