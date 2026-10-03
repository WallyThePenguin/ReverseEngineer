// Snippets: say "my calendar link" and the link is typed. Each is a record (title: what you say,
// body: what's typed), so it can be searched and linked like anything else.
import { type DbOrTx, entity } from "@hearth/db";
import { ActionError, createEntity, defineAction, trashEntity, updateEntity } from "@hearth/kernel";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { id, liveEntity } from "../shared.ts";
import type { Snippet } from "./clean.ts";

const trigger = z.string().trim().min(2).max(100);
const text = z.string().min(1).max(10_000);

export async function snippetsOf(db: DbOrTx): Promise<(Snippet & { id: string })[]> {
  const rows = await db
    .select({ id: entity.id, trigger: entity.title, text: entity.body })
    .from(entity)
    .where(and(eq(entity.type, "snippet"), isNull(entity.deletedAt)))
    .orderBy(asc(entity.title));
  return rows.map((r) => ({ id: r.id, trigger: r.trigger, text: r.text ?? "" }));
}

async function taken(db: DbOrTx, said: string, except?: string) {
  const [row] = await db
    .select({ id: entity.id })
    .from(entity)
    .where(
      and(
        eq(entity.type, "snippet"),
        isNull(entity.deletedAt),
        sql`lower(${entity.title}) = lower(${said})`,
      ),
    );
  return Boolean(row && row.id !== except);
}

export const snippetActions = [
  defineAction({
    name: "snippet.list",
    description: "Your snippets: what you say, and the text that's typed for it.",
    input: z.object({}),
    risk: "read",
    handler: (_i, ctx) => snippetsOf(ctx.tx),
  }),
  defineAction({
    name: "snippet.save",
    description: "Add a snippet, or change one (pass its id).",
    input: z.object({ id: id.optional(), trigger, text }),
    risk: "internal",
    callers: ["owner"],
    async handler(i, ctx) {
      if (await taken(ctx.tx, i.trigger, i.id))
        throw new ActionError("conflict", `There's already a snippet for "${i.trigger}".`);
      if (i.id) {
        if (!(await liveEntity(ctx.tx, i.id, "snippet")))
          throw new ActionError("not_found", "No such snippet");
        await updateEntity(ctx, i.id, { title: i.trigger, body: i.text });
        return { id: i.id };
      }
      const row = await createEntity(ctx, { type: "snippet", title: i.trigger, body: i.text });
      return { id: row.id };
    },
  }),
  defineAction({
    name: "snippet.remove",
    description: "Remove a snippet.",
    input: z.object({ id }),
    risk: "internal",
    callers: ["owner"],
    async handler(i, ctx) {
      if (!(await liveEntity(ctx.tx, i.id, "snippet")))
        throw new ActionError("not_found", "No such snippet");
      await trashEntity(ctx, i.id);
      return { id: i.id };
    },
  }),
];
