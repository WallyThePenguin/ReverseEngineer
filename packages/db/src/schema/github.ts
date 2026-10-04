// GitHub (M7). Mirrors migrations/0019_github.up.sql.
import { integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const githubAccount = pgTable("github_account", {
  login: text("login").primaryKey(),
  /** Sealed with the vault key. */
  token: text("token").notNull(),
  syncedAt: ts("synced_at"),
  lastError: text("last_error"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const githubRepo = pgTable("github_repo", {
  fullName: text("full_name").primaryKey(),
  seenUntil: ts("seen_until"),
  polledAt: ts("polled_at"),
});

export type GithubPrState = "open" | "draft" | "merged" | "closed";

export const githubPr = pgTable(
  "github_pr",
  {
    entityId: uuid("entity_id").primaryKey(),
    repo: text("repo").notNull(),
    number: integer("number").notNull(),
    url: text("url").notNull(),
    author: text("author").notNull(),
    headRef: text("head_ref").notNull(),
    state: text("state").$type<GithubPrState>().notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [unique().on(t.repo, t.number)],
);
