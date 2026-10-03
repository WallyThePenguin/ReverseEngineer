// Slack (M7, PLAN.md section 8.3): your team's Slack read in with your own token. What people
// write there is outside content for Jarvis, @mentions and direct messages land in the inbox, and
// Jarvis never posts: Hearth only reads.
import { localDate } from "@hearth/core";
import { entity, slackChannel, slackMessage, slackUser, slackWorkspace } from "@hearth/db";
import {
  ActionError,
  type DigestItem,
  defineAction,
  defineModule,
  getSetting,
  type ReflexDef,
} from "@hearth/kernel";
import { and, desc, eq, gte, ilike, inArray } from "drizzle-orm";
import { z } from "zod";
import { describeRow, liveEntity, preview } from "../shared.ts";
import { SlackError } from "./api.ts";
import { sealToken, slackApi, syncSlack } from "./sync.ts";

export { httpSlack, SLACK_SERVICE, type SlackApi } from "./api.ts";
export { FakeSlack } from "./fake.ts";

/** What a Slack app for Hearth needs (user token scopes), shown in Settings. */
export const SLACK_SCOPES = [
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "mpim:history",
  "mpim:read",
  "users:read",
  "users:read.email",
  "search:read",
];

const syncFailed: ReflexDef = {
  name: "slack.sync_failed",
  description: "When Slack stops syncing, you get one notice a day about it.",
  mode: "always",
  on: ["slack.sync_failed"],
  async run(event, ctx) {
    const rules = await getSetting(ctx.db, "owner.dayRules");
    return [
      {
        kind: "tell",
        notification: {
          kind: "system.alert",
          title: "Slack isn't syncing",
          body: String(event.payload.error ?? "").slice(0, 1000),
          urgency: "normal",
          dedupeKey: `slack.sync_failed:${localDate(event.at, rules.timeZone)}`,
        },
      },
    ];
  },
};

interface MessageRow {
  id: string;
  type: "slack_message";
  title: string;
  text: string;
  channel: string;
  sentAt: Date;
  mentionsMe: boolean;
  inThread: boolean;
}

async function digest(
  ctx: Parameters<NonNullable<Parameters<typeof defineModule>[0]["digest"]>>[0],
) {
  const rows = await ctx.db
    .select({ id: slackMessage.entityId, title: entity.title })
    .from(slackMessage)
    .innerJoin(entity, eq(entity.id, slackMessage.entityId))
    .where(and(eq(slackMessage.mentionsMe, true), gte(slackMessage.sentAt, ctx.since)))
    .orderBy(desc(slackMessage.sentAt))
    .limit(6);
  const items: DigestItem[] = rows
    .slice(0, 5)
    .map((r) => ({ bucket: "today", text: r.title, entityId: r.id, outside: true }));
  if (rows.length > 5)
    items.push({ bucket: "today", text: "More Slack mentions are in the inbox.", outside: true });
  return items;
}

export const slackModule = defineModule({
  name: "slack",
  description: "Slack: your team's channels and direct messages, read in. Hearth never posts.",
  entityTypes: ["slack_message"],
  // Other people write Slack: reading it makes the rest of Jarvis's turn untrusted (D25).
  outsideTypes: ["slack_message"],
  events: [
    {
      kind: "slack.mentioned",
      description: "Someone @mentioned you or sent you a direct message. Payload: channel, kind.",
    },
    { kind: "slack.sync_failed", description: "Syncing Slack failed. Payload: error." },
  ],
  kernelEvents: ["entity.created"],
  knowledge: {
    async slack_message(entityId, ctx) {
      const row = await liveEntity(ctx.db, entityId, "slack_message");
      if (!row) return null;
      const [m] = await ctx.db
        .select({
          channel: slackChannel.name,
          kind: slackChannel.kind,
          sentAt: slackMessage.sentAt,
        })
        .from(slackMessage)
        .innerJoin(slackChannel, eq(slackChannel.id, slackMessage.channelId))
        .where(eq(slackMessage.entityId, entityId));
      const replies = await ctx.db
        .select({ title: entity.title, body: entity.body })
        .from(entity)
        .where(and(eq(entity.parentId, entityId), eq(entity.type, "slack_message")))
        .orderBy(entity.createdAt)
        .limit(50);
      const tail = replies.length
        ? ["## Replies", ...replies.map((r) => `- ${r.title}: ${preview(r.body, 400)}`)].join("\n")
        : "";
      const extra = m ? [`Slack ${m.kind === "dm" ? "direct message" : `#${m.channel}`}`] : [];
      return describeRow(row, extra, tail);
    },
  },
  actions: [
    defineAction({
      name: "slack.connect",
      description: "Connect your Slack workspace with a Slack app's User OAuth Token (xoxp-...).",
      input: z.object({
        token: z
          .string()
          .trim()
          .regex(/^xox[pe]-[A-Za-z0-9-]{10,300}$/),
      }),
      // Only you, from Settings; the audit log keeps none of it.
      risk: "secret",
      callers: ["owner"],
      async handler(i, ctx) {
        let me: Awaited<ReturnType<ReturnType<typeof slackApi>["whoami"]>>;
        try {
          me = await slackApi(ctx).whoami(i.token);
        } catch (err) {
          throw new ActionError(
            "invalid_input",
            err instanceof SlackError ? err.message : "Slack couldn't be reached.",
          );
        }
        const token = sealToken(ctx, me.teamId, i.token);
        // One workspace: connecting another replaces it.
        await ctx.tx.delete(slackWorkspace);
        await ctx.tx.insert(slackWorkspace).values({
          teamId: me.teamId,
          teamName: me.team,
          url: me.url,
          userId: me.userId,
          token,
        });
        return { team: me.team, url: me.url };
      },
    }),
    defineAction({
      name: "slack.status",
      description: "Whether Slack is connected, which workspace, and how syncing is going.",
      input: z.object({}),
      risk: "read",
      async handler(_i, ctx) {
        const [ws] = await ctx.tx
          .select({
            team: slackWorkspace.teamName,
            url: slackWorkspace.url,
            syncedAt: slackWorkspace.syncedAt,
            lastError: slackWorkspace.lastError,
          })
          .from(slackWorkspace)
          .limit(1);
        return { connected: Boolean(ws), ...(ws ?? {}), scopes: SLACK_SCOPES };
      },
    }),
    defineAction({
      name: "slack.disconnect",
      description: "Forget the Slack workspace: its token, channels and messages leave Hearth.",
      input: z.object({}),
      risk: "internal",
      callers: ["owner"],
      async handler(_i, ctx) {
        const ids = ctx.tx.select({ id: slackMessage.entityId }).from(slackMessage);
        await ctx.tx.delete(entity).where(inArray(entity.id, ids));
        await ctx.tx.delete(slackUser);
        await ctx.tx.delete(slackWorkspace);
        return { disconnected: true };
      },
    }),
    defineAction({
      name: "slack.channels",
      description: "The Slack channels and direct messages you're in, and which are read in.",
      input: z.object({}),
      risk: "read",
      handler: (_i, ctx) =>
        ctx.tx
          .select({
            id: slackChannel.id,
            name: slackChannel.name,
            kind: slackChannel.kind,
            ingest: slackChannel.ingest,
            polledAt: slackChannel.polledAt,
          })
          .from(slackChannel)
          .orderBy(slackChannel.kind, slackChannel.name),
    }),
    defineAction({
      name: "slack.set_channel",
      description: "Read a Slack channel in, or stop reading it (its mentions still come in).",
      input: z.object({ id: z.string().regex(/^[A-Z0-9]{2,40}$/), ingest: z.boolean() }),
      risk: "internal",
      callers: ["owner"],
      async handler(i, ctx) {
        const [row] = await ctx.tx
          .update(slackChannel)
          .set({ ingest: i.ingest })
          .where(eq(slackChannel.id, i.id))
          .returning({ id: slackChannel.id });
        if (!row) throw new ActionError("not_found", "No such Slack channel.");
        return { id: row.id, ingest: i.ingest };
      },
    }),
    defineAction({
      name: "slack.messages",
      description:
        "Recent Slack messages, newest first: optionally in one channel (by name), only ones that @mention you, or containing some words. Messages are written by other people.",
      input: z.object({
        channel: z.string().trim().max(200).optional(),
        mentionsMe: z.boolean().default(false),
        query: z.string().trim().max(200).optional(),
        limit: z.number().int().min(1).max(100).default(30),
      }),
      risk: "read",
      async handler(i, ctx): Promise<MessageRow[]> {
        const name = i.channel?.replace(/^#/, "");
        const rows = await ctx.tx
          .select({
            id: entity.id,
            title: entity.title,
            body: entity.body,
            channel: slackChannel.name,
            sentAt: slackMessage.sentAt,
            mentionsMe: slackMessage.mentionsMe,
            threadTs: slackMessage.threadTs,
          })
          .from(slackMessage)
          .innerJoin(entity, eq(entity.id, slackMessage.entityId))
          .innerJoin(slackChannel, eq(slackChannel.id, slackMessage.channelId))
          .where(
            and(
              name ? eq(slackChannel.name, name) : undefined,
              i.mentionsMe ? eq(slackMessage.mentionsMe, true) : undefined,
              i.query ? ilike(entity.body, `%${i.query.replace(/[%_\\]/g, "\\$&")}%`) : undefined,
            ),
          )
          .orderBy(desc(slackMessage.sentAt))
          .limit(i.limit);
        return rows.map((r) => ({
          id: r.id,
          type: "slack_message",
          title: r.title,
          text: preview(r.body, 500),
          channel: r.channel,
          sentAt: r.sentAt,
          mentionsMe: r.mentionsMe,
          inThread: r.threadTs !== null,
        }));
      },
    }),
    defineAction({
      name: "slack.sync",
      description: "Read new Slack messages in now.",
      input: z.object({}),
      risk: "internal",
      callers: ["owner", "system", "integration"],
      handler: (_i, ctx) => syncSlack(ctx),
    }),
  ],
  reflexes: [syncFailed],
  digest,
});
