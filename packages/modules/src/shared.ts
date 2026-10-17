// Helpers shared by the modules: schemas, and the plain-text views Jarvis reads.
import { formatDateTime, stripMentions } from "@hearth/core";
import { type DbOrTx, entity } from "@hearth/db";
import { type Caller, type EntityRow, fromOutsideTool } from "@hearth/kernel";
import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";

export const id = z.string().uuid();
export const title = z.string().trim().min(1).max(500);
export const body = z.string().max(200_000);
/** An ISO date-time string. */
export const isoDateTime = z.string().datetime({ offset: true });

/** Jarvis and outside agents change a whole record only over the version they read. */
export const mustSayBase = (caller: Caller) =>
  caller.kind === "agent" || caller.kind === "mcp_client";

/** Record types a caller can't read; "all" for one that reads no records at all. */
export type HiddenTypes = string[] | "all";

/**
 * Record types a caller can't read, even by id or search. Memory steers every turn, so it's only
 * for you, Jarvis and Hearth itself (D58). A Slack member reads no records at all, only what its
 * own actions hand it (D62); so does any kind not named here, so a new one starts with nothing.
 */
export function hiddenTypes(caller: Pick<Caller, "kind">): HiddenTypes {
  switch (caller.kind) {
    case "owner":
    case "agent":
    case "system":
      return [];
    case "mcp_client":
    case "integration":
      return ["memory_note"];
    default:
      return "all";
  }
}

/** Whether `hidden` (from hiddenTypes) leaves out records of this type. */
export const hides = (hidden: HiddenTypes, type: string) =>
  hidden === "all" || hidden.includes(type);

/** A condition leaving out the record types in `hidden`; none at all for "all". */
export const visibleTypes = (hidden: HiddenTypes) =>
  hidden === "all" ? sql`false` : hidden.length ? notInArray(entity.type, hidden) : undefined;

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

/**
 * Written by an outside tool, an integration or a Slack member, so its text is outside content
 * (D25, D62). The kernel's own test, so the two can't drift apart.
 */
export const writtenOutside = fromOutsideTool;

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
