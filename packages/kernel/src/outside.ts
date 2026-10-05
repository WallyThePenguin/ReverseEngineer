// What counts as outside content (D25, D58): records an outside tool wrote, records written by a
// turn that had read some (entity.outside), rows kept as untrusted, and types whose records quote
// the outside world (an email, a watched page). Reading any of it lowers a turn's trust.
import { type DbOrTx, entity } from "@hearth/db";
import { inArray } from "drizzle-orm";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Written by an outside tool or integration, so its text is outside content (D25). */
export const fromOutsideTool = (by: string) =>
  by.startsWith("integration:") || by.startsWith("mcp:");

/** A record whose text is outside content. */
export function isOutsideRecord(
  row: { type: string; createdBy: string; outside?: boolean | null },
  isOutsideType: (type: string) => boolean,
): boolean {
  return row.outside === true || fromOutsideTool(row.createdBy) || isOutsideType(row.type);
}

/**
 * Whether a value (an action's result, say) shows outside content: it's marked so (`outside:
 * true`, an `origin` of "untrusted"), it names an outside type or author, or it holds the ids of
 * records that are outside content. Too much to check counts as outside.
 */
export async function holdsOutside(
  db: DbOrTx,
  isOutsideType: (type: string) => boolean,
  value: unknown,
): Promise<boolean> {
  const ids = new Set<string>();
  let found = false;
  const walk = (v: unknown, depth: number) => {
    if (found || depth > 8) return;
    if (ids.size > 500) {
      found = true;
      return;
    }
    if (typeof v === "string") {
      if (UUID.test(v)) ids.add(v);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if ((k === "type" || k === "otherType") && typeof x === "string")
          found ||= isOutsideType(x);
        if (k === "createdBy" && typeof x === "string") found ||= fromOutsideTool(x);
        if (k === "outside" && x === true) found = true;
        if (/origin$/i.test(k) && x === "untrusted") found = true;
        walk(x, depth + 1);
      }
    }
  };
  walk(value, 0);
  if (found) return true;
  if (ids.size === 0) return false;
  const rows = await db
    .select({ type: entity.type, createdBy: entity.createdBy, outside: entity.outside })
    .from(entity)
    .where(inArray(entity.id, [...ids]));
  return rows.some((r) => isOutsideRecord(r, isOutsideType));
}
