// The sign-in vault and your own routines (B2). Mirrors migrations/0005_vault_and_routines.up.sql.
import { boolean, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const vaultLogin = pgTable(
  "vault_login",
  {
    id: uuid("id").primaryKey(),
    /** The site it belongs to, like "example.com"; it's filled there and on its subdomains only. */
    site: text("site").notNull(),
    username: text("username").notNull(),
    /** The password, encrypted. Never sent to the model, the event log or the audit log. */
    secret: text("secret").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    lastUsedAt: ts("last_used_at"),
  },
  (t) => [unique().on(t.site, t.username)],
);

export const routine = pgTable("routine", {
  entityId: uuid("entity_id").primaryKey(),
  /** What to do, in your words. Never taken from outside content. */
  instructions: text("instructions").notNull(),
  cron: text("cron").notNull(),
  active: boolean("active").notNull().default(true),
});
