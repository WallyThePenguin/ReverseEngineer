// Slack (M7). Mirrors migrations/0018_slack.up.sql and 0032_integrations.up.sql.
import { boolean, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** How a connector's syncing is going. "revoked": its token stopped working; polling waits. */
export type ConnectorSyncState = "ok" | "failing" | "revoked";

export const slackWorkspace = pgTable("slack_workspace", {
  teamId: text("team_id").primaryKey(),
  teamName: text("team_name").notNull(),
  url: text("url").notNull(),
  userId: text("user_id").notNull(),
  /** Sealed with the vault key. */
  token: text("token").notNull(),
  channelsAt: ts("channels_at"),
  /** The newest @mention seen, as a Slack ts. */
  mentionsTs: text("mentions_ts"),
  syncedAt: ts("synced_at"),
  lastError: text("last_error"),
  createdAt: ts("created_at").notNull().defaultNow(),
  syncState: text("sync_state").$type<ConnectorSyncState>().notNull().default("ok"),
  failures: integer("failures").notNull().default(0),
  failingSince: ts("failing_since"),
});

export type SlackChannelKind = "channel" | "private" | "group" | "dm";

export const slackChannel = pgTable("slack_channel", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind").$type<SlackChannelKind>().notNull(),
  dmUser: text("dm_user"),
  ingest: boolean("ingest").notNull().default(true),
  lastTs: text("last_ts"),
  polledAt: ts("polled_at"),
  /** Messages after last_ts and before this are still to read; then read on from backlog_top. */
  backlogTs: text("backlog_ts"),
  backlogTop: text("backlog_top"),
  /** When its recent messages were last looked over for new thread replies. */
  threadsAt: ts("threads_at"),
});

export const slackUser = pgTable("slack_user", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull(),
  name: text("name").notNull(),
  email: text("email"),
  bot: boolean("bot").notNull().default(false),
  personId: uuid("person_id"),
});

export const slackMessage = pgTable(
  "slack_message",
  {
    entityId: uuid("entity_id").primaryKey(),
    channelId: text("channel_id").notNull(),
    ts: text("ts").notNull(),
    threadTs: text("thread_ts"),
    userId: text("user_id"),
    mentionsMe: boolean("mentions_me").notNull().default(false),
    sentAt: ts("sent_at").notNull(),
    /** A thread's start: Slack's newest reply as last heard, the newest read in, and when. */
    latestReply: text("latest_reply"),
    repliesRead: text("replies_read"),
    repliesAt: ts("replies_at"),
  },
  (t) => [unique().on(t.channelId, t.ts)],
);
