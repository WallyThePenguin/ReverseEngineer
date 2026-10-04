// Helpers shared by the modules: schemas, and the plain-text views Jarvis reads.
import { formatDateTime, stripMentions } from "@hearth/core";
import { type DbOrTx, entity } from "@hearth/db";
import type { Caller, EntityRow } from "@hearth/kernel";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

export const id = z.string().uuid();
export const title = z.string().trim().min(1).max(500);
export const body = z.string().max(200_000);
/** An ISO date-time string. */
export const isoDateTime = z.string().datetime({ offset: true });

/**
 * Record types an outside agent or integration can't read, even by id or search: memory steers
 * every turn, so it's only for you and Jarvis (D58).
 */
export const hiddenTypes = (caller: Pick<Caller, "kind">): string[] =>
  caller.kind === "mcp_client" || caller.kind === "integration" ? ["memory_note"] : [];

/** "note · created 2026-10-01 9 a.m. · updated ..." */
export function headerLine(row: EntityRow, extra: string[] = []): string {
  const parts = [row.type, `created ${formatDateTime(row.createdAt)}`];
  if (row.updatedAt.getTime() !== row.createdAt.getTime())
    parts.push(`updated ${formatDateTime(row.updatedAt)}`);
  if (row.createdBy !== "owner") parts.push(`by ${row.createdBy}`);
  return [...parts, ...extra].join(" · ");
}

/** The markdown Jarvis reads for a record: title, header, body with mention tags kept as links. */
export function describeRow(row: EntityRow, extra: string[] = [], tail = ""): string {
  const lines = [`# ${row.title || "(untitled)"}`, `id: ${row.id} · ${headerLine(row, extra)}`];
  if (row.deletedAt) lines.push("(in trash)");
  if (row.body) lines.push("", row.body);
  if (tail) lines.push("", tail);
  return lines.join("\n");
}

export async function liveEntity(
  db: DbOrTx,
  entityId: string,
  type?: string,
): Promise<EntityRow | undefined> {
  const [row] = await db
    .select()
    .from(entity)
    .where(
      and(
        eq(entity.id, entityId),
        isNull(entity.deletedAt),
        ...(type ? [eq(entity.type, type)] : []),
      ),
    );
  return row;
}

/** Written by an outside tool or integration, so its text is outside content (D25). */
export const writtenOutside = (by: string) =>
  by.startsWith("integration:") || by.startsWith("mcp:");

/** A record whose text is outside content: an outside tool wrote it, or a turn that had read
 * some (D58). For digests, whose items then say `outside`. */
export const isOutside = (row: { createdBy: string; outside?: boolean | null }) =>
  row.outside === true || writtenOutside(row.createdBy);

/** A short single-line preview of a body. */
export function preview(text: string | null | undefined, max = 140): string {
  const flat = stripMentions(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
