// Jarvis's browser: page watches. Mirrors migrations/0002_page_watch.up.sql.
import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export type PageWatchMode = "browser" | "fetch";
export type PageWatchStatus = "new" | "ok" | "waiting" | "failing";

export const pageWatch = pgTable("page_watch", {
  entityId: uuid("entity_id").primaryKey(),
  url: text("url").notNull(),
  /** browser: in your Chrome, signed in as you. fetch: a plain request, for public pages. */
  mode: text("mode").$type<PageWatchMode>().notNull().default("browser"),
  /** A CSS selector to watch part of the page (browser mode only). */
  selector: text("selector"),
  everyMinutes: integer("every_minutes").notNull().default(60),
  /** What Jarvis should do when the page changes. Never taken from outside content. */
  thenAsk: text("then_ask"),
  active: boolean("active").notNull().default(true),
  nextCheckAt: ts("next_check_at"),
  lastCheckedAt: ts("last_checked_at"),
  lastChangedAt: ts("last_changed_at"),
  lastText: text("last_text"),
  previousText: text("previous_text"),
  status: text("status").$type<PageWatchStatus>().notNull().default("new"),
  lastError: text("last_error"),
  failures: integer("failures").notNull().default(0),
});
