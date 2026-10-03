// Mail and the people it comes from (M2). Mirrors migrations/0006_mail.up.sql and
// 0007_mail_drafts.up.sql and 0008_mail_waiting.up.sql.
import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const mailAccount = pgTable(
  "mail_account",
  {
    /** "gmail:me@example.com" */
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    address: text("address").notNull(),
    /** Where the next sync starts: the provider's own bookmark. */
    cursor: jsonb("cursor").$type<Record<string, unknown>>(),
    syncedAt: ts("synced_at"),
    lastError: text("last_error"),
  },
  (t) => [unique().on(t.provider, t.address)],
);

export interface MailAddress {
  address: string;
  name?: string;
}

export interface MailAttachment {
  /** Its position among the message's attachments, for fetching it from the raw message. */
  index: number;
  filename: string;
  mimeType: string;
  size: number;
  /** Set for images shown inside the message (cid: links). */
  contentId?: string;
  inline?: boolean;
}

export type MailLane = "signal" | "noise";

export const mailThread = pgTable(
  "mail_thread",
  {
    entityId: uuid("entity_id").primaryKey(),
    accountId: text("account_id").notNull(),
    rootMessageId: text("root_message_id").notNull(),
    snippet: text("snippet").notNull().default(""),
    participants: jsonb("participants").$type<MailAddress[]>().notNull().default([]),
    lastMessageAt: ts("last_message_at").notNull(),
    lastInboundAt: ts("last_inbound_at"),
    lastOutboundAt: ts("last_outbound_at"),
    messageCount: integer("message_count").notNull().default(0),
    unread: boolean("unread").notNull().default(false),
    starred: boolean("starred").notNull().default(false),
    inInbox: boolean("in_inbox").notNull().default(false),
    trashed: boolean("trashed").notNull().default(false),
    lane: text("lane").$type<MailLane>().notNull().default("signal"),
    /** "you": it needs your reply. "them": you wrote last. */
    waiting: text("waiting").$type<"you" | "them">(),
    waitingSince: ts("waiting_since"),
    /** You said it needs no reply when it had this many messages; holds until another arrives. */
    noReplyCount: integer("no_reply_count"),
    /** When Jarvis last drafted a follow-up for it. */
    nudgedAt: ts("nudged_at"),
  },
  (t) => [unique().on(t.accountId, t.rootMessageId)],
);

export const mailMessage = pgTable(
  "mail_message",
  {
    entityId: uuid("entity_id").primaryKey(),
    threadId: uuid("thread_id").notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    messageId: text("message_id").notNull(),
    inReplyTo: text("in_reply_to"),
    refs: text("refs").array().notNull().default(sql`'{}'`),
    fromAddress: text("from_address").notNull().default(""),
    fromName: text("from_name"),
    toAddresses: jsonb("to_addresses").$type<MailAddress[]>().notNull().default([]),
    ccAddresses: jsonb("cc_addresses").$type<MailAddress[]>().notNull().default([]),
    replyTo: text("reply_to"),
    sentAt: ts("sent_at").notNull(),
    labels: text("labels").array().notNull().default(sql`'{}'`),
    outbound: boolean("outbound").notNull().default(false),
    rawHash: text("raw_hash").notNull(),
    hasHtml: boolean("has_html").notNull().default(false),
    attachments: jsonb("attachments").$type<MailAttachment[]>().notNull().default([]),
    snippet: text("snippet").notNull().default(""),
  },
  (t) => [unique().on(t.accountId, t.providerId)],
);

export const mailOp = pgTable("mail_op", {
  id: uuid("id").primaryKey(),
  accountId: text("account_id").notNull(),
  threadId: uuid("thread_id").notNull(),
  providerIds: text("provider_ids").array().notNull(),
  addLabels: text("add_labels").array().notNull().default(sql`'{}'`),
  removeLabels: text("remove_labels").array().notNull().default(sql`'{}'`),
  /** Each message's labels from before, by provider id. */
  undo: jsonb("undo").$type<Record<string, string[]>>().notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const mailSenderRule = pgTable("mail_sender_rule", {
  pattern: text("pattern").primaryKey(),
  lane: text("lane").$type<MailLane>().notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const personEmail = pgTable("person_email", {
  address: text("address").primaryKey(),
  personId: uuid("person_id").notNull(),
});

export const mailDraft = pgTable("mail_draft", {
  entityId: uuid("entity_id").primaryKey(),
  accountId: text("account_id").notNull(),
  threadId: uuid("thread_id"),
  toAddresses: jsonb("to_addresses").$type<MailAddress[]>().notNull().default([]),
  ccAddresses: jsonb("cc_addresses").$type<MailAddress[]>().notNull().default([]),
  bccAddresses: jsonb("bcc_addresses").$type<MailAddress[]>().notNull().default([]),
  inReplyTo: text("in_reply_to"),
  refs: text("refs").array().notNull().default(sql`'{}'`),
});
