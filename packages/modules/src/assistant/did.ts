// What Jarvis did, one line per thing, for Today: read from the records it made, so a line is
// never a claim the model made about itself.
import { PRINCIPAL } from "@hearth/core";
import { entity, event, jarvisTurn } from "@hearth/db";
import { defineAction } from "@hearth/kernel";
import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { isoDateTime } from "../shared.ts";

/** The kinds of record that count as something done, and how each is said. */
const SAID: Record<string, (title: string) => string> = {
  email_draft: (t) => `Drafted a reply: ${t}`,
  task: (t) => `Made a task: ${t}`,
  event: (t) => `Added to your calendar: ${t}`,
  prep: (t) => `Prepared for ${t.replace(/^Prep: (.*) \(\d{4}-\d{2}-\d{2}\)$/, "$1")}`,
  brief: () => "Wrote your morning brief",
  journal: () => "Wrote your journal",
  note: (t) => `Wrote a note: ${t}`,
};

export interface Did {
  at: Date;
  text: string;
  entityId: string;
  entityType: string;
  /** The turn that did it; none when a routine's plain version or a reflex did. */
  turnId?: string;
  /** Written after reading outside content (D58), so its words may be other people's. */
  outside: boolean;
}

export const didAction = defineAction({
  name: "jarvis.did",
  description:
    "What Jarvis did since a time, one line per thing (drafts, tasks, events, prep, the brief, the journal), newest first.",
  input: z.object({ since: isoDateTime, limit: z.number().int().min(1).max(200).default(50) }),
  risk: "read",
  async handler(i, ctx): Promise<Did[]> {
    const since = new Date(i.since);
    const rows = await ctx.tx
      .select({
        id: entity.id,
        type: entity.type,
        title: entity.title,
        at: entity.createdAt,
        outside: entity.outside,
      })
      .from(entity)
      .where(
        and(
          inArray(entity.type, Object.keys(SAID)),
          eq(entity.createdBy, PRINCIPAL.jarvis),
          isNull(entity.deletedAt),
          // Never updated before it was made: lets the (type, updated_at) index narrow it.
          gte(entity.updatedAt, since),
          gte(entity.createdAt, since),
        ),
      )
      .orderBy(desc(entity.createdAt))
      .limit(i.limit);
    if (rows.length === 0) return [];
    const made = await ctx.tx
      .select({ entityId: event.entityId, turnId: jarvisTurn.id })
      .from(event)
      .innerJoin(jarvisTurn, eq(jarvisTurn.id, event.correlationId))
      .where(
        and(
          inArray(
            event.entityId,
            rows.map((r) => r.id),
          ),
          eq(event.kind, "entity.created"),
        ),
      );
    const turnOf = new Map(made.map((m) => [m.entityId, m.turnId]));
    return rows.map((r) => {
      const turnId = turnOf.get(r.id);
      return {
        at: r.at,
        text: SAID[r.type]!(r.title),
        entityId: r.id,
        entityType: r.type,
        outside: r.outside,
        ...(turnId ? { turnId } : {}),
      };
    });
  },
});
