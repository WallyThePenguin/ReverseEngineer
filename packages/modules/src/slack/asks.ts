// A Slack message for you (an @mention or a direct message): set aside for Jarvis's next
// heartbeat, which makes a task of it if it asks you to do something. One item per conversation
// (a DM, or a thread), so "hey / got a sec? / can you review X / thanks!" is one, not four; the
// heartbeat sees its latest messages. Watching is free; only the heartbeat spends a turn. Hearth
// never posts to Slack.
import { localDate, PRINCIPAL, startOfLocalDay } from "@hearth/core";
import {
  type DbOrTx,
  entity,
  heartbeatItem,
  link,
  slackChannel,
  slackMessage,
  slackUser,
  slackWorkspace,
  task,
} from "@hearth/db";
import { getSetting, type ReflexDef } from "@hearth/kernel";
import {
  and,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNull,
  lte,
  max,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { liveEntity, preview } from "../shared.ts";

/** Slack conversations set aside in one day, so a busy workspace can't flood the heartbeat. */
export const SLACK_ASKS = 15;
/** How a Slack message set aside for the heartbeat is worded: the heartbeat looks for it. */
export const SLACK_FOR_YOU = "Slack message for you";
/** The conversation's latest messages the heartbeat sees, and how much of each. */
const LATELY = 6;
const AFTER_CHARS = 200;
/** Tasks made from the conversation the heartbeat sees, newest first. */
const EARLIER = 3;

/** A conversation as one key, as conversationOf draws it: a DM is its channel, else its thread. */
const conversationKey = sql`CASE WHEN ${slackChannel.kind} = 'dm' THEN ${slackMessage.channelId}
  ELSE ${slackMessage.channelId} || ':' || coalesce(${slackMessage.threadTs}, ${slackMessage.ts}) END`;

/**
 * A task that links to this record (an m-ref in its body, say), if one is still around; with
 * `since`, only one made since then.
 */
export async function taskAbout(
  db: DbOrTx,
  recordId: string,
  since?: Date,
): Promise<string | null> {
  const [t] = await db
    .select({ id: entity.id })
    .from(link)
    .innerJoin(entity, eq(entity.id, link.fromId))
    .where(
      and(
        eq(link.toId, recordId),
        eq(entity.type, "task"),
        isNull(entity.deletedAt),
        since ? gte(entity.createdAt, since) : undefined,
      ),
    )
    .limit(1);
  return t?.id ?? null;
}

/** The message, and which of Slack's messages share its conversation: its DM, else its thread. */
async function conversationOf(db: DbOrTx, messageId: string) {
  const [m] = await db
    .select({
      channelId: slackMessage.channelId,
      ts: slackMessage.ts,
      threadTs: slackMessage.threadTs,
      kind: slackChannel.kind,
      me: slackWorkspace.userId,
    })
    .from(slackMessage)
    .innerJoin(slackChannel, eq(slackChannel.id, slackMessage.channelId))
    .innerJoin(slackWorkspace, eq(slackWorkspace.teamId, slackChannel.teamId))
    .where(eq(slackMessage.entityId, messageId));
  if (!m) return null;
  const thread = m.threadTs ?? m.ts;
  const where: SQL = and(
    eq(slackMessage.channelId, m.channelId),
    m.kind === "dm"
      ? undefined
      : or(eq(slackMessage.threadTs, thread), eq(slackMessage.ts, thread)),
  )!;
  return { ...m, where };
}

export const slackForYou: ReflexDef = {
  name: "slack.for_you",
  description: `When someone @mentions you or messages you on Slack, Jarvis makes a task of it at its next heartbeat if it asks you to do something (up to ${SLACK_ASKS} conversations a day). Nothing is posted.`,
  mode: "proactive",
  on: ["slack.mentioned"],
  async run(ev, ctx) {
    const id = ev.entityId;
    const message = id ? await liveEntity(ctx.db, id, "slack_message") : undefined;
    const convo = id && message ? await conversationOf(ctx.db, id) : null;
    if (!id || !message || !convo || (await taskAbout(ctx.db, id))) return [];
    // Already set aside: the heartbeat sees the conversation as it is by then, this one included.
    const [waiting] = await ctx.db
      .select({ id: heartbeatItem.id })
      .from(heartbeatItem)
      .innerJoin(slackMessage, eq(slackMessage.entityId, heartbeatItem.aboutId))
      .where(and(isNull(heartbeatItem.takenAt), convo.where))
      .limit(1);
    if (waiting) return [];
    // Today's conversations, not items: one the heartbeat already took comes back with each
    // window its sender writes in, and is still one conversation.
    const { timeZone } = await getSetting(ctx.db, "owner.dayRules");
    const [today] = await ctx.db
      .select({
        n: sql<number>`count(DISTINCT ${conversationKey})::int`,
        here: sql<boolean | null>`bool_or(${convo.where})`,
      })
      .from(heartbeatItem)
      .innerJoin(slackMessage, eq(slackMessage.entityId, heartbeatItem.aboutId))
      .innerJoin(slackChannel, eq(slackChannel.id, slackMessage.channelId))
      .where(gte(heartbeatItem.createdAt, startOfLocalDay(ctx.now, timeZone)));
    if (!today?.here && (today?.n ?? 0) >= SLACK_ASKS)
      return [
        {
          kind: "tell",
          notification: {
            kind: "slack.busy",
            title: `Slack's busy today: Jarvis stopped making tasks from it after ${SLACK_ASKS} conversations`,
            body: "New mentions and messages are still in the inbox. It starts again tomorrow.",
            urgency: "normal",
            dedupeKey: `slack_busy:${localDate(ctx.now, timeZone)}`,
          },
        },
      ];
    return [{ kind: "batch", text: `${SLACK_FOR_YOU}: ${message.title}`, aboutId: id }];
  },
};

/**
 * What the heartbeat should see with a Slack message: the conversation's latest messages (yours
 * included, so it can tell an ask you already answered) and any task made from it before.
 */
export async function slackContext(db: DbOrTx, messageId: string): Promise<string> {
  const convo = await conversationOf(db, messageId);
  if (!convo) return "";
  const inConvo = db.select({ id: slackMessage.entityId }).from(slackMessage).where(convo.where);
  const lately = await db
    .select({ body: entity.body, userId: slackMessage.userId, name: slackUser.name })
    .from(slackMessage)
    .innerJoin(entity, eq(entity.id, slackMessage.entityId))
    .leftJoin(slackUser, eq(slackUser.id, slackMessage.userId))
    .where(and(convo.where, isNull(entity.deletedAt)))
    .orderBy(desc(slackMessage.ts))
    .limit(LATELY);
  // The newest, so a ping about the last ask meets that ask's task, not one from months ago.
  const earlier = await db
    .selectDistinct({
      id: entity.id,
      title: entity.title,
      status: task.status,
      at: entity.createdAt,
    })
    .from(link)
    .innerJoin(entity, eq(entity.id, link.fromId))
    .innerJoin(task, eq(task.entityId, entity.id))
    .where(and(inArray(link.toId, inConvo), isNull(entity.deletedAt)))
    .orderBy(desc(entity.createdAt))
    .limit(EARLIER);
  const said = lately
    .reverse()
    .map(
      (m) =>
        `${m.userId === convo.me ? "the owner" : (m.name ?? "someone")}: "${preview(m.body, AFTER_CHARS)}"`,
    );
  const state = (s: string) =>
    s === "completed" ? "done" : s === "canceled" ? "canceled" : "open";
  const tasks = earlier.map((t) => `"${preview(t.title, 120)}" (${state(t.status)})`);
  return [
    said.length ? ` Lately in the conversation, oldest first: ${said.join("; ")}.` : "",
    tasks.length ? ` Tasks made from this conversation, newest first: ${tasks.join("; ")}.` : "",
  ].join("");
}

/**
 * Whether a task made from the conversation covers all that others said there, so the heartbeat
 * needn't look. Covered means the task was made after the last of it was seen: by you, or by a
 * heartbeat turn that took the conversation after it was said. A turn sees the conversation as it
 * was when it took it, so what came while that turn ran isn't covered by its task, and a ping
 * after the task ("any update?") isn't either.
 */
export async function slackCovered(db: DbOrTx, messageId: string): Promise<boolean> {
  const convo = await conversationOf(db, messageId);
  if (!convo) return true;
  const inConvo = db.select({ id: slackMessage.entityId }).from(slackMessage).where(convo.where);
  const [last] = await db
    .select({ at: max(entity.createdAt) })
    .from(slackMessage)
    .innerJoin(entity, eq(entity.id, slackMessage.entityId))
    .where(and(convo.where, or(isNull(slackMessage.userId), ne(slackMessage.userId, convo.me))));
  if (!last?.at) return true;
  // A heartbeat that took the conversation after it was all said, before the task was made.
  const seenFirst = db
    .select({ id: heartbeatItem.id })
    .from(heartbeatItem)
    .where(
      and(
        inArray(heartbeatItem.aboutId, inConvo),
        gte(heartbeatItem.takenAt, last.at),
        lte(heartbeatItem.takenAt, entity.createdAt),
      ),
    );
  const [covering] = await db
    .select({ id: entity.id })
    .from(link)
    .innerJoin(entity, eq(entity.id, link.fromId))
    .where(
      and(
        inArray(link.toId, inConvo),
        eq(entity.type, "task"),
        isNull(entity.deletedAt),
        gte(entity.createdAt, last.at),
        or(eq(entity.createdBy, PRINCIPAL.owner), exists(seenFirst)),
      ),
    )
    .limit(1);
  return Boolean(covering);
}
