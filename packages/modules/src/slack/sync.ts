// Bringing Slack in: the channels you're in, a few at a time, and anything that @mentions you.
// Messages are saved as records written by Slack (outside content); a mention or a direct
// message lands in the inbox once the first sync is done.
import { personEmail, slackChannel, slackMessage, slackUser, slackWorkspace } from "@hearth/db";
import { type ActionContext, addLink, createEntity, createNotification } from "@hearth/kernel";
import { and, asc, eq, sql } from "drizzle-orm";
import { VAULT_SERVICE, type Vault } from "../browser/vault.ts";
import { SLACK_SERVICE, type SlackApi, SlackError, type SlackMessage } from "./api.ts";

export type WorkspaceRow = typeof slackWorkspace.$inferSelect;
type ChannelRow = typeof slackChannel.$inferSelect;

/** Channels read per sync (Slack allows about 50 history calls a minute). */
export const CHANNELS_PER_SYNC = 15;
const FIRST_LOOK_DAYS = 3;
const CHANNEL_LIST_MS = 30 * 60_000;
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
const newer = (a: string | null | undefined, b: string) => (!a || Number(b) > Number(a) ? b : a);

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
const named = (s: string) => s.replace(/<(\/?m-ref)/gi, "‹$1");

/** A Slack user's name, asked of Slack once and kept (with the person they are, by email). */
async function userName(ctx: ActionContext, ws: WorkspaceRow, token: string, id: string) {
  const [known] = await ctx.tx.select().from(slackUser).where(eq(slackUser.id, id));
  if (known) return known;
  const u = await slackApi(ctx).user(token, id);
  const email = u?.email?.toLowerCase() ?? null;
  const [person] = email
    ? await ctx.tx.select().from(personEmail).where(eq(personEmail.address, email))
    : [];
  const row = {
    id,
    teamId: ws.teamId,
    name: (u?.name ?? id).slice(0, 200),
    email,
    bot: u?.bot ?? false,
    personId: person?.personId ?? null,
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
  const [seen] = await ctx.tx
    .select({ id: slackMessage.entityId })
    .from(slackMessage)
    .where(and(eq(slackMessage.channelId, channel.id), eq(slackMessage.ts, m.ts)));
  if (seen) return null;

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

async function refreshChannels(ctx: ActionContext, ws: WorkspaceRow, token: string) {
  for (const c of await slackApi(ctx).conversations(token)) {
    const dmUser = c.kind === "dm" && c.user ? await userName(ctx, ws, token, c.user) : null;
    const name = (dmUser?.name ?? c.name ?? c.id).slice(0, 200);
    await ctx.tx
      .insert(slackChannel)
      .values({ id: c.id, teamId: ws.teamId, name, kind: c.kind, dmUser: c.user ?? null })
      .onConflictDoUpdate({ target: slackChannel.id, set: { name, kind: c.kind } });
  }
  await ctx.tx
    .update(slackWorkspace)
    .set({ channelsAt: ctx.now })
    .where(eq(slackWorkspace.teamId, ws.teamId));
}

/** A channel Hearth only knows from a mention in it (one you aren't reading in). */
async function channelFor(ctx: ActionContext, ws: WorkspaceRow, id: string) {
  const [row] = await ctx.tx.select().from(slackChannel).where(eq(slackChannel.id, id));
  if (row) return row;
  const made = { id, teamId: ws.teamId, name: id, kind: "channel" as const, ingest: false };
  await ctx.tx.insert(slackChannel).values(made).onConflictDoNothing();
  return { ...made, dmUser: null, lastTs: null, polledAt: null };
}

export interface SlackSyncResult {
  added: number;
  mentions: number;
  channels: number;
  error?: string;
}

/** One round: the channel list now and then, your mentions, and the least recently read channels. */
export async function syncSlack(ctx: ActionContext): Promise<SlackSyncResult> {
  const result: SlackSyncResult = { added: 0, mentions: 0, channels: 0 };
  const [ws] = await ctx.tx.select().from(slackWorkspace).limit(1);
  if (!ws) return result;
  const api = slackApi(ctx);
  try {
    const token = openToken(ctx, ws);
    const settled = ws.syncedAt !== null;
    if (!ws.channelsAt || ctx.now.getTime() - ws.channelsAt.getTime() > CHANNEL_LIST_MS)
      await refreshChannels(ctx, ws, token);

    let mentionsTs = ws.mentionsTs;
    for (const m of (await api.mentions(token, ws.userId)).reverse()) {
      if (ws.mentionsTs && Number(m.ts) <= Number(ws.mentionsTs)) continue;
      mentionsTs = newer(mentionsTs, m.ts);
      const channel = await channelFor(ctx, ws, m.channel);
      const id = await saveMessage(ctx, ws, token, channel, m, {
        announce: settled,
        mention: true,
      });
      if (id) result.mentions++;
    }

    const due = await ctx.tx
      .select()
      .from(slackChannel)
      .where(and(eq(slackChannel.teamId, ws.teamId), eq(slackChannel.ingest, true)))
      .orderBy(sql`${slackChannel.polledAt} ASC NULLS FIRST`, asc(slackChannel.id))
      .limit(CHANNELS_PER_SYNC);
    const firstLook = String(ctx.now.getTime() / 1000 - FIRST_LOOK_DAYS * 86_400);
    for (const channel of due) {
      const messages = await api.history(token, channel.id, channel.lastTs ?? firstLook, 100);
      let lastTs = channel.lastTs;
      for (const m of messages) {
        lastTs = newer(lastTs, m.ts);
        // A channel's first look brings history in quietly.
        const id = await saveMessage(ctx, ws, token, channel, m, {
          announce: settled && channel.lastTs !== null,
        });
        if (id) result.added++;
      }
      await ctx.tx
        .update(slackChannel)
        .set({ lastTs: lastTs ?? firstLook, polledAt: ctx.now })
        .where(eq(slackChannel.id, channel.id));
      result.channels++;
    }
    await ctx.tx
      .update(slackWorkspace)
      .set({ mentionsTs, syncedAt: ctx.now, lastError: null })
      .where(eq(slackWorkspace.teamId, ws.teamId));
  } catch (err) {
    // Slowing down when asked is normal; the next round picks up where this one stopped.
    if (err instanceof SlackError && err.code === "ratelimited") return result;
    const message = err instanceof Error ? err.message : String(err);
    result.error = message;
    await ctx.tx
      .update(slackWorkspace)
      .set({ lastError: message })
      .where(eq(slackWorkspace.teamId, ws.teamId));
    ctx.emit({ kind: "slack.sync_failed", payload: { error: message } });
  }
  return result;
}
