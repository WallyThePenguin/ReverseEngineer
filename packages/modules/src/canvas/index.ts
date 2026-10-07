// Canvas boards (PLAN.md section 8.6): cards, shapes and arrows on a 2D plane, with @linked
// records as cards. The board is saved whole, one save at a time under its row's lock; a save says
// which version it was made from, and one made from an older version is refused so the screen can
// merge card by card and try again (D59). Its body is the board as markdown, so it links to the
// records on it and Jarvis can read it (D47).
import { type Canvas, type CanvasNode, CanvasSchema, canvasMarkdown } from "@hearth/core";
import { canvasBoard, entity } from "@hearth/db";
import {
  ActionError,
  createEntity,
  defineAction,
  defineModule,
  updateEntity,
} from "@hearth/kernel";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { describeRow, id, liveEntity, mustSayBase, title } from "../shared.ts";

/** The board and its version; `lock` holds its row so writes to it go one at a time. */
async function board(db: Parameters<typeof liveEntity>[0], boardId: string, lock = false) {
  const row = await liveEntity(db, boardId, "canvas");
  if (!row) throw new ActionError("not_found", "No such canvas");
  const read = db.select().from(canvasBoard).where(eq(canvasBoard.entityId, boardId));
  const [b] = lock ? await read.for("update") : await read;
  return { row, data: CanvasSchema.parse(b?.data ?? {}), version: b?.version ?? 0 };
}

/** Where a new card goes: below everything already on the board. */
function below(c: Canvas) {
  const bottom = Math.max(0, ...c.nodes.map((n) => n.y + n.height));
  return { x: 0, y: c.nodes.length ? bottom + 40 : 0 };
}

const newId = () => crypto.randomUUID().slice(0, 12);

export const canvasModule = defineModule({
  name: "canvas",
  description: "Canvas boards: cards, shapes, arrows and @linked records on a 2D plane.",
  entityTypes: ["canvas"],
  events: [],
  reflexes: [],
  noReflexesBecause: "A board is a place to think; the records on it carry their own reflexes.",
  knowledge: {
    async canvas(entityId, ctx) {
      const row = await liveEntity(ctx.db, entityId, "canvas");
      return row ? describeRow(row, ["a canvas board; its text and cards, top to bottom"]) : null;
    },
  },
  actions: [
    defineAction({
      name: "canvas.create",
      description: "Make a new, empty canvas board.",
      input: z.object({ title }),
      risk: "internal",
      async handler(i, ctx) {
        const row = await createEntity(ctx, { type: "canvas", title: i.title, body: "" });
        await ctx.tx
          .insert(canvasBoard)
          .values({ entityId: row.id, data: { nodes: [], edges: [] } });
        return { id: row.id };
      },
    }),
    defineAction({
      name: "canvas.list",
      description: "Canvas boards, most recently changed first.",
      input: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
      risk: "read",
      handler: (i, ctx) =>
        ctx.tx
          .select({ id: entity.id, title: entity.title, updatedAt: entity.updatedAt })
          .from(entity)
          .where(and(eq(entity.type, "canvas"), isNull(entity.deletedAt)))
          .orderBy(desc(entity.updatedAt))
          .limit(i.limit),
    }),
    defineAction({
      name: "canvas.get",
      description: "A canvas board: its title, the board (nodes and edges) and its version.",
      input: z.object({ id }),
      risk: "read",
      async handler(i, ctx) {
        const b = await board(ctx.tx, i.id);
        return { id: i.id, title: b.row.title, board: b.data, version: b.version };
      },
    }),
    defineAction({
      name: "canvas.save",
      description:
        "Save a whole canvas board (nodes and edges), replacing what was there. Pass baseVersion, the version you read with canvas.get: if it has changed since, the save fails with a conflict and you should read it again. To add cards, use canvas.add instead.",
      input: z.object({
        id,
        board: CanvasSchema,
        title: title.optional(),
        baseVersion: z.number().int().min(0).optional(),
      }),
      risk: "internal",
      async handler(i, ctx) {
        // Jarvis and outside agents save a whole board only over the version they read.
        if (i.baseVersion === undefined && mustSayBase(ctx.caller))
          throw new ActionError("invalid_input", "Pass baseVersion: the version from canvas.get.");
        const b = await board(ctx.tx, i.id, true);
        if (i.baseVersion !== undefined && i.baseVersion !== b.version)
          throw new ActionError(
            "conflict",
            "This board changed since it was read. Read it again and redo the change.",
          );
        const [saved] = await ctx.tx
          .insert(canvasBoard)
          .values({ entityId: i.id, data: i.board, version: 1 })
          .onConflictDoUpdate({
            target: canvasBoard.entityId,
            set: { data: i.board, version: sql`${canvasBoard.version} + 1` },
          })
          .returning({ version: canvasBoard.version });
        const version = saved!.version;
        await updateEntity(
          ctx,
          i.id,
          { title: i.title, body: canvasMarkdown(i.board) },
          { type: "canvas" },
        );
        return { id: i.id, version };
      },
    }),
    defineAction({
      name: "canvas.add",
      description:
        "Add cards to a canvas board, below what's there: text cards, and cards for records (recordId). Returns the new cards' ids.",
      input: z.object({
        id,
        cards: z
          .array(
            z.union([z.object({ text: z.string().min(1).max(5000) }), z.object({ recordId: id })]),
          )
          .min(1)
          .max(50),
      }),
      risk: "internal",
      async handler(i, ctx) {
        // Held until the cards are saved, so a screen's save can't land in between and be lost.
        const b = await board(ctx.tx, i.id, true);
        const at = below(b.data);
        const added: CanvasNode[] = [];
        for (const [k, card] of i.cards.entries()) {
          const pos = { x: at.x + (k % 4) * 260, y: at.y + Math.floor(k / 4) * 140 };
          if ("text" in card) {
            added.push({
              id: newId(),
              type: "text",
              text: card.text,
              width: 220,
              height: 100,
              ...pos,
            });
            continue;
          }
          const rec = await liveEntity(ctx.tx, card.recordId);
          if (!rec) throw new ActionError("not_found", `No record ${card.recordId}`);
          added.push({
            id: newId(),
            type: "entitymention",
            file: rec.id,
            entityType: rec.type,
            label: rec.title || "Untitled",
            width: 220,
            height: 72,
            ...pos,
          });
        }
        const next = { ...b.data, nodes: [...b.data.nodes, ...added] };
        await ctx.call("canvas.save", { id: i.id, board: next, baseVersion: b.version });
        return { ids: added.map((n) => n.id) };
      },
    }),
  ],
});
