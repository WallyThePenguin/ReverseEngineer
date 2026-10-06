// @Jarvis in a channel, as the take loop takes it (D62). The channel is who reads the answer:
// - in a channel that isn't on, or a group DM, which never is, the member gets one ephemeral
//   "I only answer in DMs here" a day in each channel, and no turn runs;
// - in one that's on, each thread is a conversation of its own, tainted and outside from the
//   start like a DM's, and its turn sees the thread so far: the last 20 messages, read with your
//   own token, which only reads. Everyone in the channel can read them already; they reach the
//   model wrapped as untrusted data, like the member's own words.
import { MEMBER_CONVERSATION, memberPrincipal } from "@hearth/core";
import { conversation, type DbOrTx, slackChannel, slackThread, slackUser } from "@hearth/db";
import { type ActionContext, createEntity } from "@hearth/kernel";
import { and, eq, inArray } from "drizzle-orm";
import type { SlackMessage } from "../api.ts";
import type { BotRow } from "../bot/tokens.ts";
import { named, openToken, slackApi, type WorkspaceRow } from "../save.ts";
import { type InboundRow, noteAt, plainOf, settle, writtenAt } from "./messages.ts";
import { sendNote } from "./notes.ts";
import { cleanName } from "./people.ts";

/** How much of a thread a channel turn sees (D62). */
export const THREAD_LINES = 20;
/** The most of one message it sees. */
const LINE_MAX = 1000;
/** Kinds of message that are someone saying something. */
const SAID: ReadonlySet<string> = new Set(["file_share", "thread_broadcast", "bot_message"]);

/** A line of the thread a channel turn answers in, as its turn's context keeps it. */
export interface ThreadLine {
  at: string;
  who: string;
  text: string;
}

export async function channelOf(db: DbOrTx, id: string) {
  const [ch] = await db.select().from(slackChannel).where(eq(slackChannel.id, id));
  return ch ?? null;
}

/** A channel's name as Hearth shows it: it's someone's choice, so it carries no link tags. */
export const channelName = (name: string, id: string) =>
  named(name)
    .replace(/[^\p{L}\p{N}._-]/gu, "")
    .slice(0, 80) || id;

/** An @mention where Jarvis doesn't answer: the note, once a day in each channel, and no turn. */
export async function offChannel(ctx: ActionContext, teamId: string, row: InboundRow) {
  await sendNote(ctx, "off_channel", {
    teamId,
    principal: memberPrincipal(teamId, row.userId),
    ...noteAt(row),
  });
  await settle(ctx, [row], "ignored:channel_off");
}

/** The conversation of the thread an @mention is in, made the first time; null if it isn't one. */
export async function threadConversation(
  ctx: ActionContext,
  teamId: string,
  row: InboundRow,
  ch: typeof slackChannel.$inferSelect,
) {
  // A top-level @mention starts a thread: Jarvis answers in it, never in the channel (D62).
  const threadTs = row.threadTs ?? row.ts;
  const [had] = await ctx.tx
    .select()
    .from(slackThread)
    .where(and(eq(slackThread.channelId, row.channelId), eq(slackThread.threadTs, threadTs)));
  if (had) return had.audience === "channel" ? had : null;
  const title = `Slack: #${channelName(ch.name, ch.id)}`;
  // Tainted and outside from the start (D58), like a member's DM.
  const e = await createEntity(ctx, { type: "conversation", title, outside: true });
  await ctx.tx.insert(conversation).values({
    entityId: e.id,
    startedVia: MEMBER_CONVERSATION,
    taintedAt: ctx.now,
    taintSource: title,
  });
  const [made] = await ctx.tx
    .insert(slackThread)
    .values({
      channelId: row.channelId,
      threadTs,
      teamId,
      conversationId: e.id,
      audience: "channel",
      createdAt: ctx.now,
    })
    .returning();
  return made!;
}

/** Who wrote a line of the thread: Jarvis, or someone by the name Hearth knows them by. */
function author(m: SlackMessage, bot: BotRow, names: Map<string, string>) {
  if (m.botId === bot.botId || m.user === bot.botUserId) return "Jarvis";
  if (m.botId) return "An app";
  return cleanName(names.get(m.user ?? ""), m.user ?? "Someone");
}

/**
 * The thread a channel turn answers in, without the messages it answers (they come as its own):
 * read with your own token now, before the turn is queued. Null when Slack can't be asked now;
 * the turn then waits a round.
 */
export async function threadContext(
  ctx: ActionContext,
  ws: WorkspaceRow,
  bot: BotRow,
  thread: typeof slackThread.$inferSelect,
  answering: ReadonlySet<string>,
): Promise<ThreadLine[] | null> {
  let messages: SlackMessage[];
  try {
    const token = openToken(ctx, ws);
    messages = await slackApi(ctx).thread(token, thread.channelId, thread.threadTs, THREAD_LINES);
  } catch {
    return null;
  }
  // Joins, leaves and topic changes say nothing; people's messages and posts by apps do.
  const kept = messages.filter(
    (m) => !answering.has(m.ts) && (!m.subtype || m.botId || SAID.has(m.subtype)),
  );
  const ids = [...new Set(kept.map((m) => m.user).filter((u): u is string => Boolean(u)))];
  const names = new Map<string, string>();
  if (ids.length)
    for (const u of await ctx.tx
      .select({ id: slackUser.id, name: slackUser.name })
      .from(slackUser)
      .where(inArray(slackUser.id, ids)))
      names.set(u.id, u.name);
  const lines: ThreadLine[] = [];
  for (const m of kept)
    lines.push({
      at: writtenAt(m.ts).toISOString(),
      who: author(m, bot, names),
      text: [...(await plainOf(ctx.tx, m.text))].slice(0, LINE_MAX).join(""),
    });
  return lines;
}
