// Data connectors (D73). Mirrors migrations/0049_data_sources.up.sql.
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export type DataSourceKind = "convex";
/** "read": Jarvis only reads. "approve_writes": changes too, each on your yes. */
export type DataSourceMode = "read" | "approve_writes";

export const dataSource = pgTable("data_source", {
  id: uuid("id").primaryKey(),
  label: text("label").notNull().unique(),
  kind: text("kind").$type<DataSourceKind>().notNull(),
  mode: text("mode").$type<DataSourceMode>().notNull().default("read"),
  address: text("address").notNull(),
  /** Sealed with the vault key. */
  secret: text("secret").notNull(),
  keyKind: text("key_kind").notNull(),
  checkedAt: ts("checked_at"),
  lastError: text("last_error"),
  createdAt: ts("created_at").notNull().defaultNow(),
});
