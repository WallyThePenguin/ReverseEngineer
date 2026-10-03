// Spreadsheets (M7). Mirrors migrations/0021_sheets.up.sql.
import { integer, jsonb, pgTable, uuid } from "drizzle-orm/pg-core";

export const sheetBook = pgTable("sheet_book", {
  entityId: uuid("entity_id").primaryKey(),
  data: jsonb("data").$type<{ sheets: unknown[] }>().notNull(),
  version: integer("version").notNull().default(0),
});
