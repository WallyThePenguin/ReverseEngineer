// Who's writing to Jarvis, as Slack says (D62): users.info, read with your own token (which only
// reads), before anything they wrote is taken, and again each day for everyone who has written.
// Only a full member of your workspace is answered: not a guest, a bot, someone deactivated or
// someone from another org (Slack Connect). A name or an email never says who someone is; their
// Slack id, looked up here, does. The take loop (take.ts) waits for this, so it never guesses.
import { slackBot, slackInbound, slackUser, slackWorkspace } from "@hearth/db";
import { type ActionContext, defineAction, getSetting } from "@hearth/kernel";
import { and, asc, eq, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { SlackError } from "../api.ts";
import { openToken, slackApi } from "../save.ts";

/** Looked up again after a day (D62). */
export const CHECK_EVERY_MS = 86_400_000;
/** At most this many users.info calls a round: Slack allows about 100 a minute. */
const PER_ROUND = 10;

/** Users whose messages wait on a check, then members due their daily one. */
async function due(ctx: ActionContext, teamId: string, ownerIm: string) {
  const stale = new Date(ctx.now.getTime() - CHECK_EVERY_MS);
  const unchecked = or(isNull(slackUser.checkedAt), lt(slackUser.checkedAt, stale));
  const writing = await ctx.tx
    .selectDistinct({ id: slackInbound.userId })
    .from(slackInbound)
    .leftJoin(slackUser, eq(slackUser.id, slackInbound.userId))
    .where(
      and(
        isNull(slackInbound.takenAt),
        eq(slackInbound.teamId, teamId),
        // A DM or a channel's @mention alike; your own DM with Jarvis is yours, not a member's.
        ne(slackInbound.channelId, ownerIm),
        or(isNull(slackUser.id), unchecked),
      ),
    )
    .limit(PER_ROUND);
  if (writing.length >= PER_ROUND) return writing.map((w) => w.id);
  const daily = await ctx.tx
    .select({ id: slackUser.id })
    .from(slackUser)
    .where(and(eq(slackUser.teamId, teamId), isNotNull(slackUser.principal), unchecked))
    .orderBy(asc(sql`coalesce(${slackUser.checkedAt}, 'epoch')`))
    .limit(PER_ROUND - writing.length);
  return [...new Set([...writing.map((w) => w.id), ...daily.map((d) => d.id)])];
}

export const checkMembersAction = defineAction({
  name: "slack.check_members",
  description:
    "Look up, with your own Slack token, who has written to Jarvis's bot: whether each is a full member of your workspace.",
  input: z.object({}),
  risk: "internal",
  // Only as the integration, from the worker's take loop (D62).
  callers: ["integration"],
  auditWhen: (r: { checked: number }) => r.checked > 0,
  async handler(_i, ctx) {
    const [ws] = await ctx.tx.select().from(slackWorkspace).limit(1);
    const [bot] = ws
      ? await ctx.tx.select().from(slackBot).where(eq(slackBot.teamId, ws.teamId))
      : [];
    if (!ws || !bot || !(await getSetting(ctx.tx, "slack.bot.membersOn"))) return { checked: 0 };
    const ids = await due(ctx, ws.teamId, bot.ownerIm);
    if (!ids.length) return { checked: 0 };
    const token = openToken(ctx, ws);
    let checked = 0;
    for (const id of ids) {
      let u: Awaited<ReturnType<ReturnType<typeof slackApi>["user"]>>;
      try {
        u = await slackApi(ctx).user(token, id);
      } catch (err) {
        // Slowed down or refused: what's been looked up so far stays, the rest waits a round.
        return { checked, stopped: err instanceof SlackError ? err.code : "unreachable" };
      }
      const flags = {
        name: (u?.realName || u?.name || id).slice(0, 200),
        email: u?.email?.toLowerCase() ?? null,
        bot: u?.bot ?? false,
        guest: u?.guest ?? false,
        external: Boolean(u?.teamId && u.teamId !== ws.teamId),
        // Slack doesn't know them: they're no one Jarvis answers.
        deleted: u ? Boolean(u.deleted) : true,
        checkedAt: ctx.now,
      };
      await ctx.tx
        .insert(slackUser)
        .values({ id, teamId: ws.teamId, ...flags })
        .onConflictDoUpdate({ target: slackUser.id, set: flags });
      checked++;
    }
    return { checked };
  },
});
