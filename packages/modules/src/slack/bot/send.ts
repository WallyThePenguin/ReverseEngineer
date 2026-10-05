// "Tell Sam the build is fixed" (D62): Jarvis finds who you mean, and messages them, or posts in a
// channel, as its own bot. Sending works like mail.send (D33):
// - the call captures who it goes to (their id, name, email and whether they're a guest) or where
//   (the channel, how many are in it, its guests, whether another org shares it), and the card
//   leads with that, then the exact text;
// - what changed after you were asked refuses to send;
// - your own send goes at once; a trusted Jarvis turn sends at once only with that action's own
//   standing rule; any turn that read outside content (an email saying "tell Sam") asks; outside
//   agents can't send at all.
// The action only adds a row to the outbox; the worker posts it (outbox.ts). What you send a
// member goes into their conversation with Jarvis too, so their answer has context.
import { memberPrincipal } from "@hearth/core";
import { slackThread } from "@hearth/db";
import {
  type ActionContext,
  ActionError,
  type Caller,
  defineAction,
  stableHash,
  stableStringify,
} from "@hearth/kernel";
import { and, eq, type SQL } from "drizzle-orm";
import { z } from "zod";
import { appendLog } from "../../chat/log.ts";
import { id } from "../../shared.ts";
import { POST_MAX } from "./filter.ts";
import { enqueue } from "./queue.ts";
import {
  type ChannelSnapshot,
  channelPlace,
  type DmSnapshot,
  dmRecipient,
  findMembers,
  postingBot,
  readerOf,
  snapshotReader,
} from "./recipients.ts";

const userId = z.string().regex(/^[UW][A-Z0-9]{2,40}$/, "A Slack user id, like U012ABCDEF.");
const channelId = z.string().regex(/^[CG][A-Z0-9]{2,40}$/, "A Slack channel id, like C012ABCDEF.");
const threadTs = z
  .string()
  .regex(/^\d{9,11}\.\d{6}$/, "A Slack message's ts, like 1700000000.000100.");
// What you approve is what goes: held to the filter's cap, so nothing on the card is cut off.
const text = z.string().trim().min(1).max(POST_MAX);

const dmSnapshot = z.object({
  user: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  guest: z.boolean(),
});
const channelSnapshot = z.object({
  channel: z.string(),
  name: z.string(),
  members: z.number().int(),
  guests: z.number().int(),
  shared: z.boolean(),
});

/** Refuses a send whose recipient changed after you were asked, or that you were never shown. */
function same(given: unknown, now: unknown, caller: Caller) {
  if (given && stableStringify(given) !== stableStringify(now))
    throw new ActionError(
      "conflict",
      "Who or where this goes changed since you were asked, so nothing was sent.",
    );
  if (!given && caller.kind !== "owner")
    throw new ActionError(
      "conflict",
      "Hearth couldn't show the owner who this would go to, so nothing was sent.",
    );
}

/**
 * Adds what you sent to the conversation Jarvis has in that place, if it has one: a member's DM,
 * or a channel thread. Returns that conversation.
 */
async function conversationAt(ctx: ActionContext, where: SQL | undefined) {
  if (!where) return null;
  const [t] = await ctx.tx
    .select({ id: slackThread.conversationId })
    .from(slackThread)
    .where(where);
  return t?.id ?? null;
}

async function logSent(ctx: ActionContext, conversationId: string, text: string, outboxId: string) {
  const [idx] = await appendLog(
    ctx.tx,
    conversationId,
    [{ kind: "assistant_message", payload: { text, sentFor: ctx.caller.principal, outboxId } }],
    ctx.now,
  );
  ctx.emit({
    kind: "conversation.appended",
    entityId: conversationId,
    payload: { conversationId, idx, kind: "assistant_message" },
  });
}

/** Queues the post, logs it where Jarvis talks with them, and says what happens next. */
async function send(
  ctx: ActionContext,
  post: { channelId: string; threadTs?: string; text: string; key: unknown; where?: SQL },
) {
  const { ws, bot } = await postingBot(ctx.tx);
  const conversationId = await conversationAt(ctx, post.where);
  const { row, created } = await enqueue(ctx, {
    // The same send twice in one turn or request is one post.
    dedupeKey: `send:${ctx.correlationId}:${stableHash(post.key)}`,
    teamId: ws.teamId,
    channelId: post.channelId,
    threadTs: post.threadTs ?? null,
    text: post.text,
    kind: "send",
    conversationId,
  });
  if (created && conversationId) await logSent(ctx, conversationId, post.text, row.id);
  return {
    queued: true,
    id: row.id,
    ...(created ? {} : { alreadyQueued: true }),
    ...(bot.syncState === "revoked"
      ? {
          waiting:
            "Slack revoked Jarvis's bot. This goes out once you paste new tokens in Settings; after a day it expires and you're told.",
        }
      : {}),
  };
}

const where = (threadTs?: string) => (threadTs ? ", in a thread" : "");

export const sendActions = [
  defineAction({
    name: "slack.find_member",
    description:
      "Find someone in your Slack workspace by name, email or Slack id, to message them with slack.dm: their Slack id, full name, email, whether they're a guest, and the person they are in Hearth. If more than one fits, ask the owner which one.",
    input: z.object({ query: z.string().trim().min(1).max(200) }),
    risk: "read",
    callers: ["owner", "agent"],
    handler: (i, ctx) => findMembers(readerOf(ctx), i.query),
  }),
  defineAction({
    name: "slack.dm",
    description:
      "Message someone in your Slack workspace as Jarvis's own bot, in its DM with them. `to` is their Slack user id (from slack.find_member) or a person's id. The owner sees exactly who it goes to and what it says.",
    input: z.object({
      to: z.union([userId, id]),
      text,
      threadTs: threadTs.optional(),
      snapshot: dmSnapshot.optional(),
    }),
    risk: "outward",
    callers: ["owner", "agent"],
    async snapshot(i, ctx) {
      await postingBot(ctx.db);
      return { snapshot: await dmRecipient(snapshotReader(ctx), i.to) };
    },
    summarize: (i: { to: string; text: string; threadTs?: string; snapshot?: DmSnapshot }) => {
      const s = i.snapshot;
      if (!s) return `Message ${i.to} on Slack as Jarvis${where(i.threadTs)}\n\n${i.text}`;
      const who = [s.email ?? "no email", s.user, ...(s.guest ? ["a guest"] : [])].join(", ");
      // All of it: the card shows exactly what goes out.
      return `Message ${s.name} (${who}) on Slack as Jarvis${where(i.threadTs)}\n\n${i.text}`;
    },
    async handler(i, ctx) {
      const { ws } = await postingBot(ctx.tx);
      const now = await dmRecipient(readerOf(ctx), i.to);
      same(i.snapshot, now, ctx.caller);
      const done = await send(ctx, {
        channelId: now.user,
        threadTs: i.threadTs,
        text: i.text,
        key: { to: now.user, text: i.text, threadTs: i.threadTs ?? null },
        // Their DM with Jarvis, however it's threaded (D62).
        where: and(
          eq(slackThread.teamId, ws.teamId),
          eq(slackThread.member, memberPrincipal(ws.teamId, now.user)),
          eq(slackThread.audience, "member"),
          eq(slackThread.threadTs, ""),
        ),
      });
      return { ...done, to: now.name };
    },
  }),
  defineAction({
    name: "slack.post_in_channel",
    description:
      "Post in a Slack channel as Jarvis's own bot, at the top or in a thread. Only channels Jarvis has been invited to. The owner sees where it goes, how many people are there, and what it says.",
    input: z.object({
      channelId,
      text,
      threadTs: threadTs.optional(),
      snapshot: channelSnapshot.optional(),
    }),
    risk: "outward",
    callers: ["owner", "agent"],
    snapshot: async (i, ctx) => ({
      snapshot: await channelPlace(snapshotReader(ctx), i.channelId),
    }),
    summarize: (i: {
      channelId: string;
      text: string;
      threadTs?: string;
      snapshot?: ChannelSnapshot;
    }) => {
      const s = i.snapshot;
      if (!s) return `Post in ${i.channelId} on Slack as Jarvis${where(i.threadTs)}\n\n${i.text}`;
      const guests = s.guests ? `${s.guests} of them guests` : "no guests";
      const shared = s.shared ? ", shared with another org" : "";
      return `Post in #${s.name} (${s.members} people, ${guests}${shared}) on Slack as Jarvis${where(i.threadTs)}\n\n${i.text}`;
    },
    async handler(i, ctx) {
      const now = await channelPlace(readerOf(ctx), i.channelId);
      same(i.snapshot, now, ctx.caller);
      const done = await send(ctx, {
        channelId: i.channelId,
        threadTs: i.threadTs,
        text: i.text,
        key: { channel: i.channelId, text: i.text, threadTs: i.threadTs ?? null },
        where: i.threadTs
          ? and(eq(slackThread.channelId, i.channelId), eq(slackThread.threadTs, i.threadTs))
          : undefined,
      });
      return { ...done, channel: now.name };
    },
  }),
];
