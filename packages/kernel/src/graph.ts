// Entity and link helpers every module's actions use. Mention links are re-derived from the
// body on every save, in the same transaction, so links can't drift (PLAN.md section 5.3).
import { JARVIS_ENTITY_ID, mentionAnchor, mentionContext, parseMentions } from "@hearth/core";
import { type DbOrTx, entity, link } from "@hearth/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { ActionError, notFound } from "./errors.ts";
import { newId } from "./ids.ts";
import type { ActionContext } from "./types.ts";

export type EntityRow = typeof entity.$inferSelect;

export interface NewEntity {
  id?: string;
  type: string;
  title: string;
  body?: string | null;
  parentId?: string | null;
}

export async function getEntity(db: DbOrTx, id: string): Promise<EntityRow | undefined> {
  const [row] = await db.select().from(entity).where(eq(entity.id, id));
  return row;
}

/** Loads a live (not trashed) entity, optionally of a given type, or throws not_found. */
export async function requireEntity(db: DbOrTx, id: string, type?: string): Promise<EntityRow> {
  const row = await getEntity(db, id);
  if (!row || row.deletedAt || (type && row.type !== type)) throw notFound(type ?? "Record");
  return row;
}

export async function createEntity(ctx: ActionContext, input: NewEntity): Promise<EntityRow> {
  if (input.parentId) await requireEntity(ctx.tx, input.parentId);
  const [row] = await ctx.tx
    .insert(entity)
    .values({
      id: input.id ?? newId(),
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      parentId: input.parentId ?? null,
      createdAt: ctx.now,
      updatedAt: ctx.now,
      createdBy: ctx.caller.principal,
      updatedBy: ctx.caller.principal,
    })
    .returning();
  const created = row!;
  ctx.emit({
    kind: "entity.created",
    entityId: created.id,
    payload: { type: created.type, title: created.title, parentId: created.parentId },
  });
  if (created.body) await syncMentions(ctx, created);
  return created;
}

export interface EntityPatch {
  title?: string;
  body?: string | null;
}

export async function updateEntity(
  ctx: ActionContext,
  id: string,
  patch: EntityPatch,
  opts: { expectedRevision?: number; type?: string } = {},
): Promise<EntityRow> {
  const [current] = await ctx.tx.select().from(entity).where(eq(entity.id, id)).for("update");
  if (!current || current.deletedAt || (opts.type && current.type !== opts.type)) {
    throw notFound(opts.type ?? "Record");
  }
  if (opts.expectedRevision !== undefined && opts.expectedRevision !== current.revision) {
    throw new ActionError(
      "conflict",
      "This record changed since you opened it. Reload and try again.",
    );
  }
  const changed: string[] = [];
  if (patch.title !== undefined && patch.title !== current.title) changed.push("title");
  if (patch.body !== undefined && patch.body !== current.body) changed.push("body");
  if (changed.length === 0) return current;
  const [row] = await ctx.tx
    .update(entity)
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      updatedAt: ctx.now,
      updatedBy: ctx.caller.principal,
      revision: current.revision + 1,
    })
    .where(eq(entity.id, id))
    .returning();
  const updated = row!;
  ctx.emit({ kind: "entity.updated", entityId: id, payload: { type: updated.type, changed } });
  if (changed.includes("body")) await syncMentions(ctx, updated);
  return updated;
}

/** Marks a record changed without editing its text (used when a module table changes). */
export async function touchEntity(
  ctx: ActionContext,
  id: string,
  changed: string[],
): Promise<EntityRow> {
  const [row] = await ctx.tx
    .update(entity)
    .set({ updatedAt: ctx.now, updatedBy: ctx.caller.principal })
    .where(and(eq(entity.id, id), isNull(entity.deletedAt)))
    .returning();
  if (!row) throw notFound("Record");
  ctx.emit({ kind: "entity.updated", entityId: id, payload: { type: row.type, changed } });
  return row;
}

export async function trashEntity(ctx: ActionContext, id: string): Promise<EntityRow> {
  const current = await requireEntity(ctx.tx, id);
  const [row] = await ctx.tx
    .update(entity)
    .set({ deletedAt: ctx.now, updatedAt: ctx.now, updatedBy: ctx.caller.principal })
    .where(eq(entity.id, id))
    .returning();
  ctx.emit({
    kind: "entity.deleted",
    entityId: id,
    payload: { type: current.type, title: current.title },
  });
  return row!;
}

export async function restoreEntity(ctx: ActionContext, id: string): Promise<EntityRow> {
  const [row] = await ctx.tx
    .update(entity)
    .set({ deletedAt: null, updatedAt: ctx.now, updatedBy: ctx.caller.principal })
    .where(eq(entity.id, id))
    .returning();
  if (!row) throw notFound("Record");
  ctx.emit({ kind: "entity.restored", entityId: id, payload: { type: row.type } });
  return row;
}

/** Re-derives this record's mention links from its body and emits what changed. */
export async function syncMentions(ctx: ActionContext, source: EntityRow): Promise<void> {
  const body = source.body ?? "";
  const mentions = parseMentions(body).filter((m) => m.id !== source.id);
  const targetIds = [...new Set(mentions.map((m) => m.id))];
  const targets = targetIds.length
    ? await ctx.tx
        .select({ id: entity.id, type: entity.type })
        .from(entity)
        .where(and(inArray(entity.id, targetIds), isNull(entity.deletedAt)))
    : [];
  const typeOf = new Map(targets.map((t) => [t.id, t.type]));
  const desired = new Map(
    mentions.filter((m) => typeOf.has(m.id)).map((m) => [`${m.id}|${mentionAnchor(m)}`, m]),
  );

  const existing = await ctx.tx
    .select()
    .from(link)
    .where(and(eq(link.fromId, source.id), eq(link.kind, "mention")));
  const existingKeys = new Set(existing.map((l) => `${l.toId}|${l.anchor}`));

  for (const l of existing) {
    if (desired.has(`${l.toId}|${l.anchor}`)) continue;
    await ctx.tx.delete(link).where(eq(link.id, l.id));
    ctx.emit({
      kind: "link.removed",
      entityId: source.id,
      payload: { fromId: source.id, toId: l.toId, kind: "mention", anchor: l.anchor },
    });
  }

  for (const [key, m] of desired) {
    if (existingKeys.has(key)) continue;
    const anchor = mentionAnchor(m);
    await ctx.tx
      .insert(link)
      .values({
        id: newId(),
        fromId: source.id,
        toId: m.id,
        kind: "mention",
        anchor,
        createdBy: ctx.caller.principal,
        createdAt: ctx.now,
      })
      .onConflictDoNothing();
    ctx.emit({
      kind: "link.added",
      entityId: source.id,
      payload: {
        fromId: source.id,
        toId: m.id,
        kind: "mention",
        anchor,
        fromType: source.type,
        toType: typeOf.get(m.id),
      },
    });
    if (m.id === JARVIS_ENTITY_ID) {
      ctx.emit({
        kind: "jarvis.mentioned",
        entityId: source.id,
        payload: {
          anchor,
          type: source.type,
          parentId: source.parentId,
          context: mentionContext(body, m.index),
        },
      });
    }
  }
}

/** Adds a non-mention link (attachment, related, participant...). Idempotent. */
export async function addLink(
  ctx: ActionContext,
  input: {
    fromId: string;
    toId: string;
    kind: Exclude<(typeof link.$inferInsert)["kind"], "mention">;
    anchor?: string;
  },
): Promise<void> {
  const from = await requireEntity(ctx.tx, input.fromId);
  const to = await requireEntity(ctx.tx, input.toId);
  const anchor = input.anchor ?? "";
  const inserted = await ctx.tx
    .insert(link)
    .values({
      id: newId(),
      fromId: from.id,
      toId: to.id,
      kind: input.kind,
      anchor,
      createdBy: ctx.caller.principal,
      createdAt: ctx.now,
    })
    .onConflictDoNothing()
    .returning({ id: link.id });
  if (inserted.length > 0) {
    ctx.emit({
      kind: "link.added",
      entityId: from.id,
      payload: {
        fromId: from.id,
        toId: to.id,
        kind: input.kind,
        anchor,
        fromType: from.type,
        toType: to.type,
      },
    });
  }
}

export async function removeLink(
  ctx: ActionContext,
  input: { fromId: string; toId: string; kind: string; anchor?: string },
): Promise<void> {
  const anchor = input.anchor ?? "";
  const removed = await ctx.tx
    .delete(link)
    .where(
      and(
        eq(link.fromId, input.fromId),
        eq(link.toId, input.toId),
        eq(link.kind, input.kind as "related"),
        eq(link.anchor, anchor),
      ),
    )
    .returning({ id: link.id });
  if (removed.length > 0) {
    ctx.emit({ kind: "link.removed", entityId: input.fromId, payload: { ...input, anchor } });
  }
}
