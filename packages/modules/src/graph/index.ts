// Generic record operations that work on every type: get, search, backlinks, trash, links.
// Reflexes live in the modules that own each record type.
import { entity, link } from "@hearth/db";
import {
  ActionError,
  addLink,
  defineAction,
  defineModule,
  getEntity,
  notFound,
  removeLink,
} from "@hearth/kernel";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { id, preview } from "../shared.ts";
import { listTrash, restoreTree, trashTree } from "./trash.ts";

const LINKABLE = ["attachment", "related", "participant", "derived_from", "reply"] as const;

export interface LinkView {
  id: string;
  kind: string;
  anchor: string;
  otherId: string;
  otherType: string;
  otherTitle: string;
}

/** Records only the owner may bring back from trash. */
const OWNER_ONLY_TYPES = new Set(["snippet"]);

export const graphModule = defineModule({
  name: "graph",
  description: "Search, links and trash for every kind of record.",
  entityTypes: [],
  events: [],
  kernelEvents: ["entity.deleted", "entity.restored", "link.added", "link.removed"],
  knowledge: {},
  reflexes: [],
  noReflexesBecause:
    "Generic record operations; reflexes live in the module that owns each record type.",
  actions: [
    defineAction({
      name: "entity.get",
      description: "Get any record by id: its type, title, body and timestamps.",
      input: z.object({ id }),
      risk: "read",
      async handler(input, ctx) {
        const row = await getEntity(ctx.tx, input.id);
        if (!row) throw notFound("Record");
        return row;
      },
    }),
    defineAction({
      name: "entity.search",
      description:
        "Find records by words in their title or body, best matches first. Optionally limit to types such as note, task, person, comment.",
      input: z.object({
        query: z.string().trim().min(1).max(200),
        types: z.array(z.string()).max(10).optional(),
        limit: z.number().int().min(1).max(50).default(15),
      }),
      risk: "read",
      async handler(input, ctx) {
        const q = input.query;
        const tsq = sql`websearch_to_tsquery('english', ${q})`;
        const rank = sql<number>`ts_rank(${sql.raw("search")}, ${tsq}) + similarity(${entity.title}, ${q})`;
        const rows = await ctx.tx
          .select({
            id: entity.id,
            type: entity.type,
            title: entity.title,
            body: entity.body,
            updatedAt: entity.updatedAt,
            rank,
          })
          .from(entity)
          .where(
            and(
              isNull(entity.deletedAt),
              input.types?.length ? inArray(entity.type, input.types) : undefined,
              or(
                sql`${sql.raw("search")} @@ ${tsq}`,
                sql`${entity.title} % ${q}`,
                sql`${entity.title} ILIKE ${`%${q}%`}`,
              ),
            ),
          )
          .orderBy(desc(rank), desc(entity.updatedAt))
          .limit(input.limit);
        return rows.map((r) => ({
          id: r.id,
          type: r.type,
          title: r.title,
          preview: preview(r.body),
          updatedAt: r.updatedAt,
        }));
      },
    }),
    defineAction({
      name: "entity.recent",
      description: "List recently changed records, optionally of certain types.",
      input: z.object({
        types: z.array(z.string()).max(10).optional(),
        limit: z.number().int().min(1).max(100).default(30),
      }),
      risk: "read",
      async handler(input, ctx) {
        const rows = await ctx.tx
          .select({
            id: entity.id,
            type: entity.type,
            title: entity.title,
            updatedAt: entity.updatedAt,
          })
          .from(entity)
          .where(
            and(
              isNull(entity.deletedAt),
              input.types?.length
                ? inArray(entity.type, input.types)
                : sql`${entity.type} NOT IN ('comment', 'conversation', 'agent')`,
            ),
          )
          .orderBy(desc(entity.updatedAt))
          .limit(input.limit);
        return rows;
      },
    }),
    defineAction({
      name: "entity.links",
      description: "Show what a record links to and what links to it (backlinks), with titles.",
      input: z.object({ id }),
      risk: "read",
      async handler(input, ctx) {
        const view = async (dir: "out" | "in"): Promise<LinkView[]> => {
          const other = dir === "out" ? link.toId : link.fromId;
          const rows = await ctx.tx
            .select({
              id: link.id,
              kind: link.kind,
              anchor: link.anchor,
              otherId: other,
              otherType: entity.type,
              otherTitle: entity.title,
            })
            .from(link)
            .innerJoin(entity, and(eq(entity.id, other), isNull(entity.deletedAt)))
            .where(eq(dir === "out" ? link.fromId : link.toId, input.id))
            .orderBy(desc(link.createdAt));
          return rows;
        };
        return { outgoing: await view("out"), incoming: await view("in") };
      },
    }),
    defineAction({
      name: "entity.trash",
      description:
        "Move a record to trash, with its comments, subtasks and subpages. It can be restored.",
      input: z.object({ id }),
      risk: "destructive",
      summarize: (i) => `Move record ${i.id} to trash`,
      handler: async (input, ctx) => trashTree(ctx, input.id),
    }),
    defineAction({
      name: "entity.restore",
      description:
        "Bring a record back from trash, with whatever went to the trash with it (its subtasks, subpages, comments).",
      input: z.object({ id }),
      risk: "internal",
      async handler(input, ctx) {
        // A snippet is typed into whatever app you dictate into, so only you bring one back.
        const [row] = await ctx.tx
          .select({ type: entity.type })
          .from(entity)
          .where(eq(entity.id, input.id));
        if (row && OWNER_ONLY_TYPES.has(row.type) && ctx.caller.kind !== "owner")
          throw new ActionError("forbidden", "Only the owner can restore this.");
        return restoreTree(ctx, input.id);
      },
    }),
    defineAction({
      name: "entity.trashed",
      description:
        "List what's in the trash, most recently trashed first. Records that went with another (subtasks, subpages) are counted on its row.",
      input: z.object({ limit: z.number().int().min(1).max(200).default(100) }),
      risk: "read",
      handler: async (input, ctx) => listTrash(ctx.tx, input.limit),
    }),
    defineAction({
      name: "link.add",
      description:
        "Link two records (related, attachment, participant, derived_from or reply). @mentions in text link automatically.",
      input: z.object({ fromId: id, toId: id, kind: z.enum(LINKABLE).default("related") }),
      risk: "internal",
      async handler(input, ctx) {
        await addLink(ctx, input);
        return { linked: true };
      },
    }),
    defineAction({
      name: "link.remove",
      description: "Remove a link that was added with link.add.",
      input: z.object({ fromId: id, toId: id, kind: z.enum(LINKABLE).default("related") }),
      risk: "internal",
      async handler(input, ctx) {
        await removeLink(ctx, input);
        return { removed: true };
      },
    }),
  ],
});
