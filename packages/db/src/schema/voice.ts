// Voice (M3). Mirrors migrations/0014_voice.up.sql.
import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const dictation = pgTable("dictation", {
  entityId: uuid("entity_id").primaryKey(),
  raw: text("raw").notNull(),
  app: text("app"),
  windowTitle: text("window_title"),
  style: text("style"),
  durationMs: integer("duration_ms"),
  cleanupMs: integer("cleanup_ms").notNull(),
  polished: boolean("polished").notNull().default(false),
});

export const dictionaryEntry = pgTable("dictionary_entry", {
  id: uuid("id").primaryKey(),
  heard: text("heard"),
  write: text("write").notNull(),
  learned: boolean("learned").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
