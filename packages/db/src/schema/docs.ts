// Live docs (M4). Mirrors migrations/0012_docs.up.sql.
import { bigint, bigserial, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { bytea } from "./graph.ts";

export const docState = pgTable("doc_state", {
  entityId: uuid("entity_id").primaryKey(),
  /** The Loro snapshot, history included. */
  snapshot: bytea("snapshot").notNull(),
  /** The last update folded into the snapshot. */
  upto: bigint("upto", { mode: "number" }).notNull().default(0),
  /** The record's revision when its body last matched the doc. */
  revision: integer("revision").notNull(),
});

export const docUpdate = pgTable("doc_update", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  entityId: uuid("entity_id").notNull(),
  data: bytea("data").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
