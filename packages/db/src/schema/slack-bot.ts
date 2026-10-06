// Jarvis's own Slack bot (D62). Mirrors the tables of migrations/0033_slack_bot.up.sql.
import { integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ConnectorSyncState } from "./slack.ts";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const slackBot = pgTable("slack_bot", {
  teamId: text("team_id").primaryKey(),
  appId: text("app_id").notNull(),
  botUserId: text("bot_user_id").notNull(),
  botId: text("bot_id").notNull(),
  /** The bot's DM with you: the only place a message can be yours. */
  ownerIm: text("owner_im").notNull(),
  /** Only the install that connected the bot opens its socket. */
  installId: text("install_id").notNull(),
  /** Sealed under "<team>:bot" and "<team>:app", so neither opens in the other's place. */
  botToken: text("bot_token").notNull(),
  appToken: text("app_token").notNull(),
  connectedAt: ts("connected_at").notNull().defaultNow(),
  /** Nothing older than this Slack ts is read in; set on the first connect. */
  listenFrom: text("listen_from"),
  /** The newest @Jarvis in a channel that catch-up has read. */
  mentionsTs: text("mentions_ts"),
  syncState: text("sync_state").$type<ConnectorSyncState>().notNull().default("ok"),
  failures: integer("failures").notNull().default(0),
  failingSince: ts("failing_since"),
  lastError: text("last_error"),
  /** When the socket was last connected. */
  syncedAt: ts("synced_at"),
});

export const slackAnswer = pgTable("slack_answer", {
  id: uuid("id").primaryKey(),
  teamId: text("team_id").notNull(),
  title: text("title").notNull().default(""),
  body: text("body").notNull(),
  /** Null: for everyone. Otherwise only these members' Slack ids. */
  users: text("users").array(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Who reads Jarvis's answer in a place: a member in their DM, a channel, or you. */
export type SlackAudience = "member" | "channel" | "owner";

export const slackThread = pgTable(
  "slack_thread",
  {
    channelId: text("channel_id").notNull(),
    /** "" for a DM, which is one conversation however it's threaded. */
    threadTs: text("thread_ts").notNull().default(""),
    teamId: text("team_id").notNull(),
    conversationId: uuid("conversation_id").notNull().unique(),
    audience: text("audience").$type<SlackAudience>().notNull(),
    /** The member a DM is with. */
    member: text("member"),
    /** The newest message read in here (a Slack ts). */
    mark: text("mark"),
    pausedUntil: ts("paused_until"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.threadTs] })],
);

export const slackInbound = pgTable(
  "slack_inbound",
  {
    channelId: text("channel_id").notNull(),
    ts: text("ts").notNull(),
    teamId: text("team_id").notNull(),
    userId: text("user_id").notNull(),
    threadTs: text("thread_ts"),
    channelType: text("channel_type").notNull(),
    subtype: text("subtype").$type<"file_share" | "thread_broadcast">(),
    /** At most 4,000 characters; cleared after 30 days. */
    text: text("text"),
    source: text("source").$type<"event" | "catchup">().notNull(),
    eventId: text("event_id"),
    receivedAt: ts("received_at").notNull().defaultNow(),
    takenAt: ts("taken_at"),
    outcome: text("outcome"),
    conversationId: uuid("conversation_id"),
    /** The turn that folded it in. */
    turnId: uuid("turn_id"),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.ts] })],
);

export type SlackOutboxKind = "answer" | "send" | "note";
/** "unknown": a channel post Hearth couldn't read back, which may not have gone out. */
export type SlackOutboxState = "queued" | "sending" | "sent" | "failed" | "expired" | "unknown";

export const slackOutbox = pgTable("slack_outbox", {
  id: uuid("id").primaryKey(),
  /** answer:<turnId> for a turn's answer: a rerun can't add a second post. */
  dedupeKey: text("dedupe_key").notNull().unique(),
  teamId: text("team_id").notNull(),
  channelId: text("channel_id").notNull(),
  threadTs: text("thread_ts"),
  /** Set for an ephemeral note: the only one who sees it. */
  ephemeralTo: text("ephemeral_to"),
  text: text("text").notNull(),
  kind: text("kind").$type<SlackOutboxKind>().notNull(),
  conversationId: uuid("conversation_id"),
  turnId: uuid("turn_id"),
  approvalId: uuid("approval_id"),
  createdBy: text("created_by").notNull(),
  state: text("state").$type<SlackOutboxState>().notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  notBefore: ts("not_before").notNull().defaultNow(),
  sendingAt: ts("sending_at"),
  /** The post's Slack ts, once it's out. */
  sentTs: text("sent_ts"),
  error: text("error"),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  finishedAt: ts("finished_at"),
});
