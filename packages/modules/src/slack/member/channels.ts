// The channels Jarvis answers @mentions in (D62). Each is off until you turn it on, and only a
// channel you'd show anything Jarvis says there to can be on: you're in it, it isn't shared with
// another org (Slack Connect), and no guest is in it, all read with your own token, which only
// reads. Jarvis must have been invited too, or it neither hears the @mention nor can answer it.
// The check runs again every hour (slack.check_channels, from the worker's take loop), and the
// take loop waits for it before a turn in a channel checked longer ago than that. A channel that
// fails it is turned off, and you're told why. A group DM or a DM is never on.
import { localDate } from "@hearth/core";
import { type DbOrTx, slackBot, slackChannel, slackWorkspace } from "@hearth/db";
import {
  type ActionContext,
  ActionError,
  createNotification,
  defineAction,
  getSetting,
} from "@hearth/kernel";
import { and, asc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { type SlackApi, SlackError, type SlackUser } from "../api.ts";
import { workspace } from "../bot/tokens.ts";
import { named, openToken, slackApi } from "../save.ts";

/** A channel's check is good for an hour (D62). */
export const CHANNEL_CHECK_MS = 3_600_000;
/** At most this many channels are checked a round. */
const PER_ROUND = 10;

type ChannelRow = typeof slackChannel.$inferSelect;
type Ws = typeof slackWorkspace.$inferSelect;

/** Whether Jarvis answers @mentions in a channel: on, and a channel rather than a group DM. */
export const isOn = (ch: ChannelRow | null | undefined): ch is ChannelRow =>
  Boolean(ch && ch.jarvisTier !== "off" && (ch.kind === "channel" || ch.kind === "private"));

/** Whether a channel's check is recent enough for a turn there. */
export const checkedLately = (ch: ChannelRow, now: Date) =>
  Boolean(ch.jarvisCheckedAt && ch.jarvisCheckedAt.getTime() > now.getTime() - CHANNEL_CHECK_MS);

/** Everyone in the workspace who's a guest or from another org: read once a check round. */
async function outsiders(api: SlackApi, token: string, ws: Ws): Promise<Set<string>> {
  const everyone: SlackUser[] = await api.users(token);
  return new Set(
    everyone.filter((u) => u.guest || (u.teamId && u.teamId !== ws.teamId)).map((u) => u.id),
  );
}

/**
 * Why a channel can't be on, in words, or null when it can. `guests` is read lazily, once for
 * every channel a round checks. Slack refusing or slowing down throws its SlackError.
 */
export async function channelProblem(
  api: SlackApi,
  token: string,
  ws: Ws,
  botUserId: string,
  id: string,
  guests: () => Promise<Set<string>>,
): Promise<string | null> {
  let facts: Awaited<ReturnType<SlackApi["channel"]>>;
  try {
    facts = await api.channel(token, id);
  } catch (err) {
    if (err instanceof SlackError && err.code === "channel_not_found")
      return "Your Slack token can't see it any more.";
    throw err;
  }
  if (facts.kind === "dm" || facts.kind === "group")
    return "It's a direct message: Jarvis answers @mentions only in channels.";
  if (facts.archived) return "It's archived.";
  if (!facts.members.includes(ws.userId)) return "You aren't in it.";
  if (facts.shared) return "It's shared with another org (Slack Connect).";
  const outside = await guests();
  const n = facts.members.filter((m) => outside.has(m)).length;
  if (n) return `${n === 1 ? "A guest is" : `${n} guests are`} in it.`;
  if (!facts.members.includes(botUserId))
    return "Jarvis hasn't been invited: invite @Jarvis there first.";
  return null;
}

/** The bot, and the channel by its id in your workspace. */
async function botAndChannel(ctx: ActionContext, id: string) {
  const ws = await workspace(ctx);
  const [bot] = await ctx.tx.select().from(slackBot).where(eq(slackBot.teamId, ws.teamId));
  if (!bot)
    throw new ActionError("unavailable", "Connect Jarvis's bot first, in Settings → Slack.");
  const [ch] = await ctx.tx
    .select()
    .from(slackChannel)
    .where(and(eq(slackChannel.id, id), eq(slackChannel.teamId, ws.teamId)));
  if (!ch)
    throw new ActionError(
      "not_found",
      "Hearth hasn't seen that channel yet. It reads your channels every few minutes.",
    );
  return { ws, bot, ch };
}

/** Turns a channel off after a failed check, and tells you why, once a day at most. */
async function turnOff(ctx: ActionContext, ch: ChannelRow, why: string) {
  await ctx.tx
    .update(slackChannel)
    .set({ jarvisTier: "off", jarvisCheckedAt: ctx.now })
    .where(eq(slackChannel.id, ch.id));
  const { timeZone } = await getSetting(ctx.tx, "owner.dayRules");
  await createNotification(ctx, {
    kind: "slack.channel_off",
    title: `Jarvis stopped answering in #${named(ch.name)}`,
    body: `${why} Turn it on again in Settings → Slack once that's fixed.`,
    lane: "signal",
    dedupeKey: `slack.channel_off:${ch.id}:${localDate(ctx.now, timeZone)}`,
  });
}

/** Channels that are on and due their hourly check, those checked longest ago first. */
function dueChannels(db: DbOrTx, teamId: string, now: Date) {
  const stale = new Date(now.getTime() - CHANNEL_CHECK_MS);
  return db
    .select()
    .from(slackChannel)
    .where(
      and(
        eq(slackChannel.teamId, teamId),
        ne(slackChannel.jarvisTier, "off"),
        or(isNull(slackChannel.jarvisCheckedAt), lt(slackChannel.jarvisCheckedAt, stale)),
      ),
    )
    .orderBy(asc(sql`coalesce(${slackChannel.jarvisCheckedAt}, 'epoch')`))
    .limit(PER_ROUND);
}

const tier = z.enum(["off", "relay", "schedule"]);
const TIER_RANK: Record<z.infer<typeof tier>, number> = { off: 0, relay: 1, schedule: 2 };

export const channelActions = [
  defineAction({
    name: "slack.channel_set",
    description:
      "Turn Jarvis on in a Slack channel, so it answers @Jarvis there, or off. relay passes messages on to you; schedule also shares your free time. Its replies there wait for your yes unless `replies` is auto.",
    input: z.object({
      channel: z.string().regex(/^[CG][A-Z0-9]{2,40}$/, "A Slack channel id, like C012ABCDEF."),
      tier,
      replies: z.enum(["auto", "review"]).optional(),
    }),
    risk: "internal",
    // Only you choose where Jarvis talks (D62).
    callers: ["owner"],
    async handler(i, ctx) {
      const { ws, bot, ch } = await botAndChannel(ctx, i.channel);
      const patch: Partial<ChannelRow> = { jarvisTier: i.tier };
      if (i.replies) patch.jarvisReplies = i.replies;
      if (i.tier !== "off" && ch.kind !== "channel" && ch.kind !== "private")
        throw new ActionError(
          "invalid_input",
          "Jarvis answers @mentions only in channels, never in a group DM or a DM.",
        );
      // Only more (a higher tier, or replies going out on their own) waits on the check: making
      // a channel safer never does, whatever Slack says (D62).
      const more =
        TIER_RANK[i.tier] > TIER_RANK[ch.jarvisTier] ||
        (i.replies === "auto" && ch.jarvisReplies !== "auto");
      if (i.tier !== "off" && more) {
        const api = slackApi(ctx);
        const token = openToken(ctx, ws);
        let why: string | null;
        try {
          why = await channelProblem(api, token, ws, bot.botUserId, ch.id, () =>
            outsiders(api, token, ws),
          );
        } catch (err) {
          const code = err instanceof SlackError ? err.code : "unreachable";
          throw new ActionError("unavailable", `Slack said ${code}. Try again in a minute.`);
        }
        if (why && ch.jarvisTier === "off")
          throw new ActionError(
            "invalid_input",
            `Jarvis can't answer in #${named(ch.name)}: ${why}`,
          );
        // It's on, and shouldn't be: off it goes, as the hourly check would turn it.
        if (why) {
          await turnOff(ctx, ch, why);
          return {
            id: ch.id,
            name: ch.name,
            tier: "off" as const,
            replies: ch.jarvisReplies,
            checkedAt: ctx.now,
            off: why,
          };
        }
        patch.jarvisCheckedAt = ctx.now;
      }
      const [row] = await ctx.tx
        .update(slackChannel)
        .set(patch)
        .where(eq(slackChannel.id, ch.id))
        .returning();
      return {
        id: row!.id,
        name: row!.name,
        tier: row!.jarvisTier,
        replies: row!.jarvisReplies,
        checkedAt: row!.jarvisCheckedAt,
      };
    },
  }),
  defineAction({
    name: "slack.check_channels",
    description:
      "Check again, with your own Slack token, that each channel Jarvis answers in still has you in it, no guests, and no other org.",
    input: z.object({}),
    risk: "internal",
    // Only as the integration, from the worker's take loop, hourly (D62).
    callers: ["integration"],
    auditWhen: (r: { checked: number }) => r.checked > 0,
    async handler(_i, ctx) {
      const [ws] = await ctx.tx.select().from(slackWorkspace).limit(1);
      const [bot] = ws
        ? await ctx.tx.select().from(slackBot).where(eq(slackBot.teamId, ws.teamId))
        : [];
      if (!ws || !bot || !(await getSetting(ctx.tx, "slack.bot.membersOn")))
        return { checked: 0, off: 0 };
      const due = await dueChannels(ctx.tx, ws.teamId, ctx.now);
      if (!due.length) return { checked: 0, off: 0 };
      const api = slackApi(ctx);
      const token = openToken(ctx, ws);
      let guests: Promise<Set<string>> | null = null;
      const lazy = () => {
        guests ??= outsiders(api, token, ws);
        return guests;
      };
      let checked = 0;
      let off = 0;
      for (const ch of due) {
        let why: string | null;
        try {
          why = isOn(ch)
            ? await channelProblem(api, token, ws, bot.botUserId, ch.id, lazy)
            : "It's a group DM: Jarvis answers @mentions only in channels.";
        } catch (err) {
          // Slowed down or refused: the rest wait a round, and nothing is turned off on a guess.
          return { checked, off, stopped: err instanceof SlackError ? err.code : "unreachable" };
        }
        checked++;
        if (why) {
          off++;
          await turnOff(ctx, ch, why);
        } else {
          await ctx.tx
            .update(slackChannel)
            .set({ jarvisCheckedAt: ctx.now })
            .where(eq(slackChannel.id, ch.id));
        }
      }
      return { checked, off };
    },
  }),
];
