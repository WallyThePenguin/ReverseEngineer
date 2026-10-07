// Login, sessions and settings. Mirrors migrations/*.sql.
import { sql } from "drizzle-orm";
import { bigint, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { bytea } from "./graph.ts";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const credential = pgTable("credential", {
  id: text("id").primaryKey(),
  principal: text("principal").notNull(),
  publicKey: bytea("public_key").notNull(),
  counter: bigint("counter", { mode: "number" }).notNull().default(0),
  transports: text("transports").array().notNull().default(sql`'{}'`),
  label: text("label").notNull().default(""),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastUsedAt: ts("last_used_at"),
  /** Null for Hearth's own address; "localhost" for the desktop app's window on this PC (D69). */
  rpId: text("rp_id").$type<"localhost">(),
});

export const session = pgTable("session", {
  tokenHash: text("token_hash").primaryKey(),
  principal: text("principal").notNull(),
  kind: text("kind").$type<"browser" | "api">().notNull(),
  label: text("label").notNull().default(""),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastSeenAt: ts("last_seen_at"),
  expiresAt: ts("expires_at"),
  revokedAt: ts("revoked_at"),
  /** The only actions a device's token may run; null for a full sign-in. */
  scopes: text("scopes").array(),
});

export const authChallenge = pgTable("auth_challenge", {
  id: text("id").primaryKey(),
  challenge: text("challenge").notNull(),
  purpose: text("purpose").$type<"register" | "login">().notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  /** The address it was made for, as credential.rpId: it's answered only there. */
  rpId: text("rp_id").$type<"localhost">(),
});

export const setting = pgTable("setting", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
