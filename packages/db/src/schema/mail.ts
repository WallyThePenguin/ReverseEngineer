// Mail and the people it comes from (M2). Mirrors migrations/0006_mail.up.sql and
// 0007_mail_drafts.up.sql, 0008_mail_waiting.up.sql, 0009_mail_invites.up.sql,
// 0022_google_pacing.up.sql, 0032_integrations.up.sql and 0034_mail_drafted.up.sql.
import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
    /** Gmail asked Hearth to slow down: no syncing until then. */
    pausedUntil: ts("paused_until"),
    syncState: text("sync_state").$type<MailSyncState>().notNull().default("ok"),
    /** Failed syncs in a row, and when the first of them was. A slowdown isn't a failure. */
    failures: integer("failures").notNull().default(0),
    failingSince: ts("failing_since"),
    /** The daily look for missing originals: where it got to, and when it last finished. */
    repairFrom: uuid("repair_from"),
    repairedAt: ts("repaired_at"),
  },
  (t) => [unique().on(t.provider, t.address)],
);

/** ok, still bringing mail in, asked by Gmail to slow down, or failing (the only bad one). */
export type MailSyncState = "ok" | "catching_up" | "paused" | "failing";

/** Messages that failed to save a few times, set aside so they never hold up the rest. */
export const mailQuarantine = pgTable(
  "mail_quarantine",
  {
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    firstFailedAt: ts("first_failed_at").notNull(),
    lastFailedAt: ts("last_failed_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.providerId] })],
);

export interface MailAddress {
  address: string;
  name?: string;
}

/** A calendar invitation a message carries (its text/calendar part). Written by the sender. */
export interface MailInvite {
  uid: string;
  /** REQUEST (an invitation or update) or CANCEL. */
  method: string;
  summary: string;
  /** When the invitation says it starts, if Hearth could read it. */
  start: string | null;
  organizer: string | null;
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
    /** When Jarvis last wrote a draft in it; kept when you throw the draft away. */
    draftedAt: ts("drafted_at"),
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
    invite: jsonb("invite").$type<MailInvite>(),
    /** Sent to many at once or by a machine; null until its original was read for it (0032). */
    bulk: boolean("bulk"),
    /** The email's fingerprint: its copy in another of your accounts has the same (0048). */
    copyKey: text("copy_key"),
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
  /** Null for a draft kept from an account that was disconnected, until you pick one (0032). */
  accountId: text("account_id"),
  threadId: uuid("thread_id"),
  toAddresses: jsonb("to_addresses").$type<MailAddress[]>().notNull().default([]),
  ccAddresses: jsonb("cc_addresses").$type<MailAddress[]>().notNull().default([]),
  bccAddresses: jsonb("bcc_addresses").$type<MailAddress[]>().notNull().default([]),
  inReplyTo: text("in_reply_to"),
  refs: text("refs").array().notNull().default(sql`'{}'`),
  /** Chosen when the draft is written, so a send can be looked for in Sent (0032). */
  messageId: text("message_id").notNull(),
});
