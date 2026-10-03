// Jarvis's memory. Mirrors migrations/0003_memory.up.sql.
import { sql } from "drizzle-orm";
import { integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** always: in every turn. topic: only when one of its keywords comes up. */
export type MemoryScope = "always" | "topic";

export const memoryNote = pgTable("memory_note", {
  entityId: uuid("entity_id").primaryKey(),
  scope: text("scope").$type<MemoryScope>().notNull().default("topic"),
  keywords: text("keywords").array().notNull().default(sql`'{}'`),
});

export const memoryRevision = pgTable(
  "memory_revision",
  {
    entityId: uuid("entity_id").notNull(),
    revision: integer("revision").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    scope: text("scope").$type<MemoryScope>().notNull(),
    keywords: text("keywords").array().notNull().default(sql`'{}'`),
    reason: text("reason"),
    changedBy: text("changed_by").notNull(),
    turnId: uuid("turn_id"),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.entityId, t.revision] })],
);
