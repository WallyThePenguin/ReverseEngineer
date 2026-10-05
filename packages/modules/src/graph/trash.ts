// The trash: a record goes there with what's under it (its comments, subtasks and subpages), all
// at the same moment, and comes back the same way. Mail, calendar and chat-app records under a
// record keep their own lifecycle: their sync owns them.
import { entity, type Tx } from "@hearth/db";
import { type ActionContext, notFound } from "@hearth/kernel";
import { and, desc, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";

/** Records that go to the trash, and come back, with the record they're under. */
export const FOLLOWS_PARENT = ["comment", "task", "note"] as const;

/** What the Trash view lists: what you make and keep in Hearth, not what syncs from elsewhere. */
export const TRASH_TYPES = [
  "note",
  "task",
  "canvas",
  "spreadsheet",
  "person",
  "company",
  "conversation",
  "meeting",
  "page_watch",
  "memory_note",
  "snippet",
  "comment",
  "brief",
  "journal",
] as const;

/** Enough for the biggest Notion import, and a stop for a parent loop. */
const MAX_DESCENDANTS = 20_000;

export interface Trashed {
  id: string;
  type: string;
  title: string;
  /** How many records under it went with it. */
  withIt: number;
}

/** Moves a record and what's under it to the trash, at one moment so they come back together. */
export async function trashTree(ctx: ActionContext, id: string): Promise<Trashed> {
  const [top] = await ctx.tx
    .update(entity)
    .set({ deletedAt: ctx.now, updatedAt: ctx.now, updatedBy: ctx.caller.principal })
    .where(and(eq(entity.id, id), isNull(entity.deletedAt)))
    .returning({ id: entity.id, type: entity.type, title: entity.title });
  if (!top) throw notFound("Record");
  ctx.emit({ kind: "entity.deleted", entityId: id, payload: { type: top.type, title: top.title } });
  let withIt = 0;
  let level = [id];
  while (level.length && withIt < MAX_DESCENDANTS) {
    const rows = await ctx.tx
      .update(entity)
      .set({ deletedAt: ctx.now, updatedAt: ctx.now, updatedBy: ctx.caller.principal })
      .where(
        and(
          inArray(entity.parentId, level),
          isNull(entity.deletedAt),
          inArray(entity.type, [...FOLLOWS_PARENT]),
        ),
      )
      .returning({ id: entity.id, type: entity.type, title: entity.title });
    for (const r of rows)
      ctx.emit({
        kind: "entity.deleted",
        entityId: r.id,
        payload: { type: r.type, title: r.title },
      });
    withIt += rows.length;
    level = rows.map((r) => r.id);
  }
  return { ...top, withIt };
}

/**
 * Brings a record back from the trash, with everything under it that went to the trash at the
 * same moment (its subtasks, a whole Notion import). Anything trashed under it earlier or later
 * stays where it is.
 */
export async function restoreTree(ctx: ActionContext, id: string) {
  const [was] = await ctx.tx
    .select({ deletedAt: entity.deletedAt })
    .from(entity)
    .where(eq(entity.id, id));
  if (!was) throw notFound("Record");
  const [row] = await ctx.tx
    .update(entity)
    .set({ deletedAt: null, updatedAt: ctx.now, updatedBy: ctx.caller.principal })
    .where(eq(entity.id, id))
    .returning();
  ctx.emit({ kind: "entity.restored", entityId: id, payload: { type: row!.type } });
  if (!was.deletedAt) return { ...row!, withIt: 0 };
  let withIt = 0;
  let level = [id];
  while (level.length && withIt < MAX_DESCENDANTS) {
    const rows = await ctx.tx
      .update(entity)
      .set({ deletedAt: null, updatedAt: ctx.now, updatedBy: ctx.caller.principal })
      .where(and(inArray(entity.parentId, level), eq(entity.deletedAt, was.deletedAt)))
      .returning({ id: entity.id, type: entity.type });
    for (const r of rows)
      ctx.emit({ kind: "entity.restored", entityId: r.id, payload: { type: r.type } });
    withIt += rows.length;
    level = rows.map((r) => r.id);
  }
  return { ...row!, withIt };
}

export interface TrashRow {
  id: string;
  type: string;
  title: string;
  deletedAt: Date;
  deletedBy: string;
  /** Records that went to the trash with it, and come back with it. */
  withIt: number;
}

/**
 * What's in the trash, most recently trashed first. A record that went with the record it's
 * under is counted on that record's row instead of having its own. `hidden` are the types the
 * caller can't read (memory, for outside agents: D58): they're neither listed nor counted.
 */
export async function listTrash(tx: Tx, limit: number, hidden: string[]): Promise<TrashRow[]> {
  const visible = hidden.length ? notInArray(entity.type, hidden) : undefined;
  const parent = sql`(SELECT p.deleted_at FROM entity p WHERE p.id = ${entity.parentId})`;
  const rows = await tx
    .select({
      id: entity.id,
      type: entity.type,
      title: entity.title,
      deletedAt: entity.deletedAt,
      deletedBy: entity.updatedBy,
    })
    .from(entity)
    .where(
      and(
        isNotNull(entity.deletedAt),
        inArray(entity.type, [...TRASH_TYPES]),
        visible,
        sql`(${entity.parentId} IS NULL OR ${parent} IS DISTINCT FROM ${entity.deletedAt})`,
      ),
    )
    .orderBy(desc(entity.deletedAt))
    .limit(limit);
  const moments = [...new Set(rows.map((r) => r.deletedAt!.toISOString()))];
  const counts = moments.length
    ? await tx
        .select({ at: entity.deletedAt, n: sql<number>`count(*)::int` })
        .from(entity)
        .where(
          and(
            inArray(
              entity.deletedAt,
              moments.map((m) => new Date(m)),
            ),
            visible,
          ),
        )
        .groupBy(entity.deletedAt)
    : [];
  const together = new Map(counts.map((c) => [c.at!.toISOString(), c.n]));
  // Two records trashed in one go are both shown; neither counts the other as going with it.
  const tops = new Map<string, number>();
  for (const r of rows) {
    const at = r.deletedAt!.toISOString();
    tops.set(at, (tops.get(at) ?? 0) + 1);
  }
  return rows.map((r) => {
    const at = r.deletedAt!.toISOString();
    return {
      ...r,
      deletedAt: r.deletedAt!,
      withIt: Math.max(0, (together.get(at) ?? 1) - (tops.get(at) ?? 1)),
    };
  });
}
