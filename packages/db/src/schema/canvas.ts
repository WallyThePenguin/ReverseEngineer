// Canvas boards (M7). Mirrors migrations/0017_canvas.up.sql.
import { integer, jsonb, pgTable, uuid } from "drizzle-orm/pg-core";

export const canvasBoard = pgTable("canvas_board", {
  entityId: uuid("entity_id").primaryKey(),
  data: jsonb("data").$type<{ nodes: unknown[]; edges: unknown[] }>().notNull(),
  version: integer("version").notNull().default(0),
});
