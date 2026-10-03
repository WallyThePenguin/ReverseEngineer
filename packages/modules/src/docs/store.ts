// Docs as Loro CRDTs (PLAN.md section 8.5): a note's text is a LoroText every screen edits and
// merges, with the body column kept as the readable copy. Anything that writes the body directly
// (Jarvis, the checklist) is taken into the doc as an edit the next time it's opened, so it merges
// with typing instead of overwriting it.
import { type DbOrTx, docState, docUpdate, entity } from "@hearth/db";
import { type ActionContext, type EntityRow, updateEntity } from "@hearth/kernel";
import { and, asc, eq, gt, lte, max } from "drizzle-orm";
import { LoroDoc } from "loro-crdt";

/** Record types whose text is a live doc. */
export const DOC_TYPES = new Set(["note"]);
const TEXT = "body";
/** Updates kept before they're folded into the snapshot. */
const FOLD_AFTER = 50;

export const textOf = (doc: LoroDoc) => doc.getText(TEXT).toString();

function fresh(): LoroDoc {
  const doc = new LoroDoc();
  doc.setRecordTimestamp(true);
  return doc;
}

async function append(ctx: ActionContext, id: string, data: Uint8Array, by: string) {
  await ctx.tx.insert(docUpdate).values({ entityId: id, data: Buffer.from(data), createdBy: by });
}

/**
 * The doc for a record, locked by the caller. Made from the body the first time; if the body was
 * written directly since the doc last matched it, that write becomes an edit in the doc.
 */
export async function openDoc(
  ctx: ActionContext,
  row: EntityRow,
): Promise<{ doc: LoroDoc; pending: number }> {
  const [state] = await ctx.tx.select().from(docState).where(eq(docState.entityId, row.id));
  if (!state) {
    const doc = fresh();
    if (row.body) doc.getText(TEXT).insert(0, row.body);
    doc.commit();
    await ctx.tx.insert(docState).values({
      entityId: row.id,
      snapshot: Buffer.from(doc.export({ mode: "snapshot" })),
      revision: row.revision,
    });
    return { doc, pending: 0 };
  }
  const doc = fresh();
  doc.import(state.snapshot);
  const updates = await ctx.tx
    .select({ data: docUpdate.data })
    .from(docUpdate)
    .where(and(eq(docUpdate.entityId, row.id), gt(docUpdate.seq, state.upto)))
    .orderBy(asc(docUpdate.seq));
  if (updates.length) doc.importBatch(updates.map((u) => u.data));
  let pending = updates.length;
  if (state.revision !== row.revision) {
    const body = row.body ?? "";
    if (body !== textOf(doc)) {
      const before = doc.oplogVersion();
      doc.getText(TEXT).update(body);
      doc.commit();
      await append(ctx, row.id, doc.export({ mode: "update", from: before }), row.updatedBy);
      pending++;
    }
    await setRevision(ctx.tx, row.id, row.revision);
  }
  return { doc, pending };
}

/**
 * Writes a doc's title or body as the caller (note.update). The doc first takes in any earlier
 * direct write, then this body as the caller's own edit, so history names who wrote what (a
 * later rename can't claim an earlier body change).
 */
export async function writeDoc(
  ctx: ActionContext,
  id: string,
  patch: { title?: string; body?: string },
  opts: { expectedRevision?: number; type: string },
): Promise<EntityRow> {
  const [row] = await ctx.tx.select().from(entity).where(eq(entity.id, id)).for("update");
  const [state] = row
    ? await ctx.tx.select({ id: docState.entityId }).from(docState).where(eq(docState.entityId, id))
    : [];
  if (!row || !state || row.deletedAt || !DOC_TYPES.has(row.type))
    return updateEntity(ctx, id, patch, opts);
  if (opts.expectedRevision !== undefined && opts.expectedRevision !== row.revision)
    return updateEntity(ctx, id, patch, opts); // Fails with the usual conflict.
  const { doc, pending } = await openDoc(ctx, row);
  let added = 0;
  if (patch.body !== undefined && patch.body !== textOf(doc)) {
    const before = doc.oplogVersion();
    doc.getText(TEXT).update(patch.body);
    doc.commit();
    await append(ctx, id, doc.export({ mode: "update", from: before }), ctx.caller.principal);
    added = 1;
  }
  const out = await updateEntity(ctx, id, patch, opts);
  await setRevision(ctx.tx, id, out.revision);
  await fold(ctx, id, doc, pending + added);
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
  const before = doc.oplogVersion().encode();
  doc.import(data);
  if (Buffer.from(doc.oplogVersion().encode()).equals(Buffer.from(before))) return false;
  await append(ctx, id, data, ctx.caller.principal);
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
