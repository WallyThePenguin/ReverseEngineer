// The graph: principals, entities, links, properties and tasks. Mirrors migrations/*.sql.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

export const principal = pgTable("principal", {
  id: text("id").primaryKey(),
  kind: text("kind").$type<"owner" | "agent" | "mcp_client" | "integration" | "system">().notNull(),
  displayName: text("display_name").notNull(),
  entityId: uuid("entity_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
  disabledAt: ts("disabled_at"),
});

export const entity = pgTable("entity", {
  id: uuid("id").primaryKey(),
  type: text("type").notNull(),
  title: text("title").notNull().default(""),
  body: text("body"),
  parentId: uuid("parent_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  createdBy: text("created_by").notNull(),
  updatedBy: text("updated_by").notNull(),
  deletedAt: ts("deleted_at"),
  revision: integer("revision").notNull().default(1),
});

export const LINK_KINDS = [
  "mention",
  "attachment",
  "property_ref",
  "reply",
  "derived_from",
  "participant",
  "related",
] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const link = pgTable("link", {
  id: uuid("id").primaryKey(),
  fromId: uuid("from_id").notNull(),
  toId: uuid("to_id").notNull(),
  kind: text("kind").$type<LinkKind>().notNull(),
  anchor: text("anchor").notNull().default(""),
  createdBy: text("created_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const propertyDef = pgTable("property_def", {
  id: uuid("id").primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  valueType: text("value_type").notNull(),
  options: jsonb("options"),
  appliesTo: text("applies_to").array().notNull().default(sql`'{}'`),
  isSystem: boolean("is_system").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const property = pgTable(
  "property",
  {
    entityId: uuid("entity_id").notNull(),
    defId: uuid("def_id").notNull(),
    value: jsonb("value").notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => [primaryKey({ columns: [t.entityId, t.defId] })],
);

export const task = pgTable("task", {
  entityId: uuid("entity_id").primaryKey(),
  number: integer("number").notNull().default(sql`nextval('task_number_seq')`),
  status: text("status")
    .$type<"not_started" | "in_progress" | "in_review" | "completed" | "canceled">()
    .notNull()
    .default("not_started"),
  priority: text("priority")
    .$type<"none" | "low" | "medium" | "high" | "urgent">()
    .notNull()
    .default("none"),
  dueAt: ts("due_at"),
  dueIsDate: boolean("due_is_date").notNull().default(false),
  estimateMinutes: integer("estimate_minutes"),
  assignee: text("assignee"),
  projectId: uuid("project_id"),
  completedAt: ts("completed_at"),
});

export const event = pgTable("event", {
  seq: bigint("seq", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  id: uuid("id").notNull().unique(),
  at: ts("at").notNull().defaultNow(),
  kind: text("kind").notNull(),
  entityId: uuid("entity_id"),
  actor: text("actor").notNull(),
  origin: text("origin").$type<"owner" | "agent" | "untrusted" | "system">().notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  correlationId: uuid("correlation_id"),
  causationId: uuid("causation_id"),
});

export const consumerCursor = pgTable("consumer_cursor", {
  consumer: text("consumer").primaryKey(),
  seq: bigint("seq", { mode: "number" }).notNull().default(0),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
