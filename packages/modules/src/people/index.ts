// People and agents. M0 keeps this small; M5 builds people from mail, calendar and meetings and
// adds follow-ups ("you haven't talked to X in 60 days").
import { entity } from "@hearth/db";
import { createEntity, defineAction, defineModule, updateEntity } from "@hearth/kernel";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { body, describeRow, id, liveEntity } from "../shared.ts";

export const peopleModule = defineModule({
  name: "people",
  description: "People you know, and agents like Jarvis.",
  entityTypes: ["person", "agent"],
  events: [],
  knowledge: {
    async person(entityId, ctx) {
      const row = await liveEntity(ctx.db, entityId, "person");
      return row ? describeRow(row) : null;
    },
    async agent(entityId, ctx) {
      const row = await liveEntity(ctx.db, entityId, "agent");
      return row ? describeRow(row, ["an AI agent"]) : null;
    },
  },
  actions: [
    defineAction({
      name: "person.create",
      description: "Add a person. Put details (email, how you know them) in the notes as markdown.",
      input: z.object({ name: z.string().trim().min(1).max(200), notes: body.optional() }),
      risk: "internal",
      handler: (i, ctx) =>
        createEntity(ctx, { type: "person", title: i.name, body: i.notes ?? "" }),
    }),
    defineAction({
      name: "person.update",
      description: "Rename a person or change their notes.",
      input: z.object({
        id,
        name: z.string().trim().min(1).max(200).optional(),
        notes: body.optional(),
      }),
      risk: "internal",
      handler: (i, ctx) =>
        updateEntity(ctx, i.id, { title: i.name, body: i.notes }, { type: "person" }),
    }),
    defineAction({
      name: "person.list",
      description: "List people, by name.",
      input: z.object({ limit: z.number().int().min(1).max(500).default(100) }),
      risk: "read",
      handler: (i, ctx) =>
        ctx.tx
          .select({ id: entity.id, name: entity.title, updatedAt: entity.updatedAt })
          .from(entity)
          .where(and(eq(entity.type, "person"), isNull(entity.deletedAt)))
          .orderBy(asc(entity.title))
          .limit(i.limit),
    }),
  ],
  reflexes: [],
  noReflexesBecause:
    "Follow-ups and relationship reminders arrive in M5, once people are built from mail, calendar and meetings.",
});
