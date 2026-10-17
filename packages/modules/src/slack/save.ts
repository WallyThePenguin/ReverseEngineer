// Saving what Slack says: messages are records written by Slack (outside content), and one that
// @mentions you or is a direct message lands in the inbox when `announce` says so.
import { type slackChannel, slackMessage, slackUser, type slackWorkspace } from "@hearth/db";
import { type ActionContext, addLink, createEntity, createNotification } from "@hearth/kernel";
import { and, eq, sql } from "drizzle-orm";
import { VAULT_SERVICE, type Vault } from "../browser/vault.ts";
import { personFor } from "../people/store.ts";
import { SLACK_SERVICE, type SlackApi, type SlackMessage } from "./api.ts";

/**
 * The workspace as a sync round reads it. `jarvis` is Jarvis's own bot, when it's connected: its
 * DM with you and its posts are never read back in, so its words don't come back as Slack
 * messages (D62).
 */
export type WorkspaceRow = typeof slackWorkspace.$inferSelect & { jarvis?: JarvisBot | null };

/** What the poller needs to know of Jarvis's bot to leave its words out. */
export interface JarvisBot {
  ownerIm: string;
  botId: string;
  botUserId: string;
}

/** Your DM with Jarvis, or something Jarvis posted: not read in (D62). */
export const isJarvis = (ws: WorkspaceRow, channelId: string, m: SlackMessage) =>
  Boolean(
    ws.jarvis &&
      (channelId === ws.jarvis.ownerIm ||
        m.botId === ws.jarvis.botId ||
        m.user === ws.jarvis.botUserId),
  );
export type ChannelRow = typeof slackChannel.$inferSelect;

const MAX_TEXT = 20_000;
/** Join, leave, topic and the like: nothing anyone said. */
const NOISE = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "group_join",
  "group_leave",
]);

export const slackApi = (ctx: Pick<ActionContext, "service">) =>
  ctx.service<SlackApi>(SLACK_SERVICE);

export const sealToken = (ctx: Pick<ActionContext, "service">, teamId: string, token: string) =>
  ctx.service<Vault>(VAULT_SERVICE).seal("slack.com", teamId, token);

export const openToken = (ctx: Pick<ActionContext, "service">, ws: WorkspaceRow) =>
  ctx.service<Vault>(VAULT_SERVICE).open("slack.com", ws.teamId, ws.token);

const tsDate = (ts: string) => new Date(Math.floor(Number(ts) * 1000));

/** Orders two Slack ts ("1700000000.000100") exactly: as numbers they lose the last digits. */
export function tsCompare(a: string, b: string): number {
  const [as = "", af = ""] = a.split(".");
  const [bs = "", bf = ""] = b.split(".");
  const [x, y] = [af.padEnd(6, "0"), bf.padEnd(6, "0")];
  return Number(as) - Number(bs) || (x < y ? -1 : x > y ? 1 : 0);
}

/** The later of two Slack ts, either of which may be missing. */
export const later = (a: string | null | undefined, b: string | null | undefined) =>
  !a ? (b ?? null) : !b ? a : tsCompare(b, a) > 0 ? b : a;

/** Slack's markup as plain text: @names, #channels, links with their address. */
export function plainText(text: string, names: Map<string, string>): string {
  return (
    text
      .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => `@${names.get(id) ?? id}`)
      .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
      .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
      .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
      .replace(/<(https?:[^>]+)>/g, "$1")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      // Hearth's own link tags can't be forged from Slack (they'd link records it names).
      .replace(/<(\/?m-ref)/gi, "‹$1")
  );
}

/** A name someone else chose (a person, a channel), safe to put in Hearth's text. */
export const named = (s: string) => s.replace(/<(\/?m-ref)/gi, "‹$1");

/**
 * A Slack user's name, asked of Slack once and kept, with the person they are by email. Who they
 * are is looked up each time: someone you meet or write to later becomes theirs, and someone you
 * put in the trash stops being.
 */
export async function userName(ctx: ActionContext, ws: WorkspaceRow, token: string, id: string) {
  const [known] = await ctx.tx.select().from(slackUser).where(eq(slackUser.id, id));
  if (known) {
    const personId = known.email ? await personFor(ctx.tx, known.email) : null;
    if (personId === known.personId) return known;
    await ctx.tx.update(slackUser).set({ personId }).where(eq(slackUser.id, id));
    return { ...known, personId };
  }
  const u = await slackApi(ctx).user(token, id);
  const email = u?.email?.toLowerCase() ?? null;
  const row = {
    id,
    teamId: ws.teamId,
    name: (u?.name ?? id).slice(0, 200),
    email,
    bot: u?.bot ?? false,
    personId: email ? await personFor(ctx.tx, email) : null,
  };
  await ctx.tx.insert(slackUser).values(row).onConflictDoNothing();
  return row;
}

async function names(ctx: ActionContext, ws: WorkspaceRow, token: string, text: string) {
  const out = new Map<string, string>();
  for (const [, id] of text.matchAll(/<@([A-Z0-9]+)/g))
    if (id && !out.has(id) && out.size < 20) out.set(id, (await userName(ctx, ws, token, id)).name);
  return out;
}

function where(channel: ChannelRow, dmWith?: string) {
  if (channel.kind === "dm") return `a direct message${dmWith ? ` from ${dmWith}` : ""}`;
  if (channel.kind === "group") return "a group message";
  return `#${named(channel.name)}`;
}

/** A thread's start Hearth has: Slack says its newest reply is `latest` (D61). */
export async function noteReplies(
  ctx: ActionContext,
  channelId: string,
  ts: string,
  latest: string,
) {
  await ctx.tx
    .update(slackMessage)
    .set({ latestReply: latest })
    .where(
      and(
        eq(slackMessage.channelId, channelId),
        eq(slackMessage.ts, ts),
        sql`(${slackMessage.latestReply} IS NULL OR ${slackMessage.latestReply}::numeric < ${latest}::numeric)`,
      ),
    );
}

/** Saves one message unless it's already here. Returns its record id when it was new. */
export async function saveMessage(
  ctx: ActionContext,
  ws: WorkspaceRow,
  token: string,
  channel: ChannelRow,
  m: SlackMessage,
  opts: { announce: boolean; mention?: boolean },
): Promise<string | null> {
  if ((m.subtype && NOISE.has(m.subtype)) || (!m.text.trim() && !m.subtype)) return null;
  if (isJarvis(ws, channel.id, m)) return null;
  const [seen] = await ctx.tx
    .select({ id: slackMessage.entityId })
    .from(slackMessage)
    .where(and(eq(slackMessage.channelId, channel.id), eq(slackMessage.ts, m.ts)));
  if (seen) {
    if (m.latestReply) await noteReplies(ctx, channel.id, m.ts, m.latestReply);
    return null;
  }

  const author = m.user ? await userName(ctx, ws, token, m.user) : null;
  const who = author ? named(author.name) : m.botId ? "An app" : "Someone";
  const mine = m.user === ws.userId;
  const mentionsMe =
    !mine &&
    (opts.mention === true ||
      m.text.includes(`<@${ws.userId}>`) ||
      (channel.kind === "dm" && !author?.bot));
  const text = plainText(m.text, await names(ctx, ws, token, m.text)).slice(0, MAX_TEXT);
  const reply = m.threadTs && m.threadTs !== m.ts ? m.threadTs : null;
  const [parent] = reply
    ? await ctx.tx
        .select({ id: slackMessage.entityId })
        .from(slackMessage)
        .where(and(eq(slackMessage.channelId, channel.id), eq(slackMessage.ts, reply)))
    : [];
  const title = `${who} in ${channel.kind === "dm" ? "a direct message" : where(channel)}`;
  const record = await createEntity(ctx, {
    type: "slack_message",
    title: title.slice(0, 300),
    body: text,
    parentId: parent?.id ?? null,
  });
  await ctx.tx.insert(slackMessage).values({
    entityId: record.id,
    channelId: channel.id,
    ts: m.ts,
    threadTs: reply,
    userId: m.user ?? null,
    mentionsMe,
    sentAt: tsDate(m.ts),
    latestReply: !reply && m.replyCount ? (m.latestReply ?? null) : null,
  });
  if (author?.personId)
    await addLink(ctx, { fromId: record.id, toId: author.personId, kind: "participant" });
  if (mentionsMe && opts.announce) {
    await createNotification(ctx, {
      kind: "slack.mention",
      title:
        channel.kind === "dm"
          ? `${who} sent you a direct message on Slack`
          : `${who} mentioned you in ${where(channel)}`,
      entityId: record.id,
      urgency: "normal",
      lane: "signal",
      dedupeKey: `slack:${channel.id}:${m.ts}`,
    });
    ctx.emit({
      kind: "slack.mentioned",
      entityId: record.id,
      payload: { channel: channel.name, kind: channel.kind },
    });
  }
  return record.id;
}
