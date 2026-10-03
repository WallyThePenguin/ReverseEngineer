// People and companies (M5). Mirrors migrations/0010_people.up.sql.
import { integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";

export const company = pgTable("company", {
  entityId: uuid("entity_id").primaryKey(),
  /** "acme.example": where its people's mail comes from. */
  domain: text("domain").notNull().unique(),
});

export const person = pgTable("person", {
  entityId: uuid("entity_id").primaryKey(),
  companyId: uuid("company_id"),
  /** Remind you when you haven't talked for this many days. */
  followUpDays: integer("follow_up_days"),
  /** Your own fields: "Birthday", "Kids", "Met at". */
  fields: jsonb("fields").$type<Record<string, string>>().notNull().default({}),
});
