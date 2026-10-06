// Notion tasks (D68). Mirrors migrations/0045_notion_sync.up.sql.
import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ConnectorSyncState } from "./slack.ts";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** Which columns of the board say who, done and due (modules notion/columns.ts). */
export interface NotionColumns {
  title: string;
  assignee: string | null;
  status: string | null;
  doneOptions: string[];
  doneBox: string | null;
  due: string | null;
}

export const notionAccount = pgTable("notion_account", {
  botId: text("bot_id").primaryKey(),
  workspace: text("workspace"),
  /** Sealed with the vault key. */
  token: text("token").notNull(),
  sourceId: text("source_id"),
  sourceTitle: text("source_title"),
  ownerUserId: text("owner_user_id"),
  ownerName: text("owner_name"),
  columns: jsonb("columns").$type<NotionColumns>(),
  syncedAt: ts("synced_at"),
  lastError: text("last_error"),
  createdAt: ts("created_at").notNull().defaultNow(),
  syncState: text("sync_state").$type<ConnectorSyncState>().notNull().default("ok"),
  failures: integer("failures").notNull().default(0),
  failingSince: ts("failing_since"),
});

export const notionTask = pgTable("notion_task", {
  entityId: uuid("entity_id").primaryKey(),
  pageId: text("page_id").notNull().unique(),
  sourceId: text("source_id").notNull(),
  url: text("url").notNull(),
  status: text("status"),
  done: boolean("done").notNull().default(false),
  dueAt: text("due_at"),
  dueIsDate: boolean("due_is_date").notNull().default(false),
  assigned: boolean("assigned").notNull().default(true),
  backfill: boolean("backfill").notNull().default(false),
  editedAt: ts("edited_at").notNull(),
});
