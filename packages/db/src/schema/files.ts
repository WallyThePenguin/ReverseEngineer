// Files you add (pasted, dropped or uploaded). Mirrors migrations/0050_files.up.sql.
import { index, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";

export const storedFile = pgTable(
  "stored_file",
  {
    entityId: uuid("entity_id").primaryKey(),
    /** SHA-256 of its bytes, which are in the data folder's blobs (mail/blobs.ts). */
    hash: text("hash").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
  },
  (t) => [index("stored_file_hash_idx").on(t.hash)],
);
