// Bringing Slack in: the channels you're in, a few at a time, the replies in their threads, and
// anything that @mentions you. A mention or a direct message lands in the inbox once the first
// sync is done. How the round went is saved on the workspace (D61): a token that stops working
// stops the polling until you paste a new one, and failing is told once, when it starts.
import { slackChannel, slackWorkspace } from "@hearth/db";
import { type ActionContext, savepoint } from "@hearth/kernel";
import { and, asc, eq, sql } from "drizzle-orm";
import { closeAlerts, nextHealth, type Trouble, worst } from "../connector-health.ts";
import { SlackError } from "./api.ts";
import {
  type Budget,
  CALLS_PER_SYNC,
  onlyThis,
  PASSING,
  readChannel,
  readThreads,
  setAside,
} from "./read.ts";
import {
  later,
  openToken,
  saveMessage,
  slackApi,
  tsCompare,
  userName,
  type WorkspaceRow,
} from "./save.ts";

export { openToken, plainText, sealToken, slackApi, type WorkspaceRow } from "./save.ts";

/** Channels read per sync (Slack allows about 50 history calls a minute). */
export const CHANNELS_PER_SYNC = 15;
const FIRST_LOOK_DAYS = 3;
const CHANNEL_LIST_MS = 30 * 60_000;

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
  return {
    ...made,
    dmUser: null,
    lastTs: null,
    polledAt: null,
    backlogTs: null,
    backlogTop: null,
    threadsAt: null,
  };
}

async function readMentions(ctx: ActionContext, ws: WorkspaceRow, token: string, settled: boolean) {
  let mentionsTs = ws.mentionsTs;
  let count = 0;
  for (const m of (await slackApi(ctx).mentions(token, ws.userId)).reverse()) {
    if (ws.mentionsTs && tsCompare(m.ts, ws.mentionsTs) <= 0) continue;
    mentionsTs = later(mentionsTs, m.ts);
    const channel = await channelFor(ctx, ws, m.channel);
    if (await saveMessage(ctx, ws, token, channel, m, { announce: settled, mention: true }))
      count++;
  }
  await ctx.tx
    .update(slackWorkspace)
    .set({ mentionsTs })
    .where(eq(slackWorkspace.teamId, ws.teamId));
  return count;
}

function troubleOf(err: unknown): Trouble {
  if (err instanceof SlackError)
    return {
      kind: err.revoked ? "revoked" : PASSING.test(err.code) ? "transient" : "refused",
      message: err.message,
    };
  const offline =
    err instanceof TypeError || (err instanceof Error && /abort|timeout/i.test(err.name));
  return {
    kind: "transient",
    message: offline
      ? "Slack couldn't be reached."
      : err instanceof Error
        ? err.message
        : String(err),
  };
}

export interface SlackSyncResult {
  added: number;
  mentions: number;
  channels: number;
  /** Thread replies read in. */
  replies: number;
  error?: string;
}

/** One round: the channel list now and then, your mentions, the least recently read channels. */
export async function syncSlack(ctx: ActionContext): Promise<SlackSyncResult> {
  const result: SlackSyncResult = { added: 0, mentions: 0, channels: 0, replies: 0 };
  const [ws] = await ctx.tx.select().from(slackWorkspace).limit(1);
  if (!ws) return result;
  // A token that stopped working isn't tried again until you paste a new one.
  if (ws.syncState === "revoked") return { ...result, error: ws.lastError ?? undefined };
  const troubles: Trouble[] = [];
  let progressed = false;
  let slowed = false;
  try {
    const token = openToken(ctx, ws);
    const settled = ws.syncedAt !== null;
    if (!ws.channelsAt || ctx.now.getTime() - ws.channelsAt.getTime() > CHANNEL_LIST_MS)
      await savepoint(ctx, (sp) => refreshChannels(sp, ws, token));
    result.mentions = await savepoint(ctx, (sp) => readMentions(sp, ws, token, settled));
    progressed = true;

    const due = await ctx.tx
      .select()
      .from(slackChannel)
      .where(and(eq(slackChannel.teamId, ws.teamId), eq(slackChannel.ingest, true)))
      .orderBy(sql`${slackChannel.polledAt} ASC NULLS FIRST`, asc(slackChannel.id))
      .limit(CHANNELS_PER_SYNC);
    const firstLook = String(Math.floor(ctx.now.getTime() / 1000) - FIRST_LOOK_DAYS * 86_400);
    const budget: Budget = { calls: CALLS_PER_SYNC };
    for (const channel of due) {
      if (budget.calls <= 0) break;
      const floor = channel.lastTs ?? firstLook;
      try {
        result.added += await savepoint(ctx, (sp) =>
          readChannel(sp, ws, token, channel, floor, budget, settled),
        );
        result.channels++;
      } catch (err) {
        if (!onlyThis(err)) throw err;
        // This channel only: the others carry on.
        await setAside(ctx, channel, err, troubles, true);
      }
    }
    result.replies = await readThreads(ctx, ws, token, budget, settled, troubles);
  } catch (err) {
    // Slowing down when asked is normal; the next round picks up where this one stopped.
    if (err instanceof SlackError && err.code === "ratelimited") slowed = true;
    else troubles.unshift(troubleOf(err));
  }
  const trouble = worst(troubles);
  if (trouble) result.error = trouble.message;
  if (slowed && !trouble && !progressed) return result;
  const next = nextHealth(ws, ctx.now, trouble, progressed);
  await ctx.tx.update(slackWorkspace).set(next.values).where(eq(slackWorkspace.teamId, ws.teamId));
  if (next.recovered) await closeAlerts(ctx, "slack");
  if (next.alert)
    ctx.emit({
      kind: "slack.sync_failed",
      payload: {
        error: next.values.lastError,
        since: next.alert.since.toISOString(),
        reconnect: next.alert.reconnect,
      },
    });
  return result;
}
