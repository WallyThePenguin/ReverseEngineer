// Saving memory notes. Every save keeps a version, so any change, yours or Jarvis's, can be
// looked at and undone.
import { entity, type MemoryScope, memoryNote, memoryRevision } from "@hearth/db";
import {
  type ActionContext,
  ActionError,
  createEntity,
  type EntityRow,
  requireEntity,
  updateEntity,
} from "@hearth/kernel";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

export interface NoteFields {
  title: string;
  body: string;
  scope: MemoryScope;
  keywords: string[];
}

export interface MemoryNoteView extends NoteFields {
  id: string;
  revision: number;
  updatedAt: Date;
  updatedBy: string;
}

/** Keywords are matched case-insensitively, so they're stored lowercased and without repeats. */
export function cleanKeywords(words: string[]): string[] {
  return [...new Set(words.map((w) => w.trim().toLowerCase()).filter(Boolean))].slice(0, 30);
}

/**
 * Jarvis can't change what it remembers once outside content (a web page, an email) is in its
 * turn: otherwise a page could plant instructions that every later turn reads.
 */
export function refuseUntrusted(ctx: ActionContext): void {
  if (ctx.caller.origin === "untrusted")
    throw new ActionError(
      "forbidden",
      "Memory can't be changed after reading outside content. Note it with jarvis_observe instead, and the owner can add it.",
    );
}

export async function loadNote(
  tx: ActionContext["tx"],
  id: string,
): Promise<MemoryNoteView | null> {
  const [row] = await tx
    .select({ e: entity, m: memoryNote })
    .from(entity)
    .innerJoin(memoryNote, eq(memoryNote.entityId, entity.id))
    .where(and(eq(entity.id, id), isNull(entity.deletedAt)));
  if (!row) return null;
  const [last] = await tx
    .select({ revision: memoryRevision.revision })
    .from(memoryRevision)
    .where(eq(memoryRevision.entityId, id))
    .orderBy(desc(memoryRevision.revision))
    .limit(1);
  return toView(row.e, row.m, last?.revision ?? 1);
}

export function toView(
  e: EntityRow,
  m: typeof memoryNote.$inferSelect,
  revision: number,
): MemoryNoteView {
  return {
    id: e.id,
    title: e.title,
    body: e.body ?? "",
    scope: m.scope,
    keywords: m.keywords,
    revision,
    updatedAt: e.updatedAt,
    updatedBy: e.updatedBy,
  };
}

export async function findByTitle(tx: ActionContext["tx"], title: string) {
  const [row] = await tx
    .select({ id: entity.id })
    .from(entity)
    .innerJoin(memoryNote, eq(memoryNote.entityId, entity.id))
    .where(
      and(
        eq(entity.type, "memory_note"),
        isNull(entity.deletedAt),
        sql`lower(${entity.title}) = lower(${title})`,
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

async function addRevision(
  ctx: ActionContext,
  id: string,
  fields: NoteFields,
  reason: string | null,
): Promise<number> {
  const [last] = await ctx.tx
    .select({ revision: memoryRevision.revision })
    .from(memoryRevision)
    .where(eq(memoryRevision.entityId, id))
    .orderBy(desc(memoryRevision.revision))
    .limit(1);
  const revision = (last?.revision ?? 0) + 1;
  await ctx.tx.insert(memoryRevision).values({
    entityId: id,
    revision,
    ...fields,
    reason,
    changedBy: ctx.caller.principal,
    turnId: ctx.caller.turnId ?? null,
    at: ctx.now,
  });
  ctx.emit({
    kind: "memory.changed",
    entityId: id,
    payload: { title: fields.title, revision, scope: fields.scope, reason },
  });
  return revision;
}

export async function createNote(
  ctx: ActionContext,
  fields: NoteFields,
  reason: string | null,
): Promise<MemoryNoteView> {
  const row = await createEntity(ctx, {
    type: "memory_note",
    title: fields.title,
    body: fields.body,
  });
  const keywords = cleanKeywords(fields.keywords);
  const [m] = await ctx.tx
    .insert(memoryNote)
    .values({ entityId: row.id, scope: fields.scope, keywords })
    .returning();
  const revision = await addRevision(ctx, row.id, { ...fields, keywords }, reason);
  return toView(row, m!, revision);
}

/** Applies a change; saves a new version only if something actually changed. */
export async function changeNote(
  ctx: ActionContext,
  id: string,
  patch: Partial<NoteFields>,
  reason: string | null,
  expectedRevision?: number,
): Promise<MemoryNoteView> {
  await requireEntity(ctx.tx, id, "memory_note");
  const current = await loadNote(ctx.tx, id);
  if (!current) throw new ActionError("not_found", "Memory note not found");
  if (expectedRevision !== undefined && expectedRevision !== current.revision)
    throw new ActionError(
      "conflict",
      "This memory changed since you opened it. Reload and try again.",
    );
  const next: NoteFields = {
    title: patch.title ?? current.title,
    body: patch.body ?? current.body,
    scope: patch.scope ?? current.scope,
    keywords: patch.keywords ? cleanKeywords(patch.keywords) : current.keywords,
  };
  const same =
    next.title === current.title &&
    next.body === current.body &&
    next.scope === current.scope &&
    next.keywords.join("\n") === current.keywords.join("\n");
  if (same) return current;
  const row = await updateEntity(ctx, id, { title: next.title, body: next.body });
  const [m] = await ctx.tx
    .update(memoryNote)
    .set({ scope: next.scope, keywords: next.keywords })
    .where(eq(memoryNote.entityId, id))
    .returning();
  const revision = await addRevision(ctx, id, next, reason);
  return toView(row, m!, revision);
}
