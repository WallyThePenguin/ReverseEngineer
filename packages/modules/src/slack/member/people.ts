// Who a Slack member is to Jarvis, and how far it goes for them (D62). Identity is by Slack id
// only, read with your own token, never by a name or an email: anyone can call themselves "Ana".
// A full member is in your workspace, not a guest, not a bot and not deactivated. Everyone starts
// at `relay` (a message passed on to you); `schedule` (your free time and meeting requests) is
// yours to give, one person at a time. In a channel's thread the tier is the lower of the
// member's and the channel's.
import {
  type DbOrTx,
  principal,
  type SlackChannelTier,
  type SlackMemberTier,
  type SlackReplies,
  slackChannel,
  slackThread,
  slackUser,
} from "@hearth/db";
import { type ActionContext, ActionError, type Caller } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { named } from "../save.ts";

export type SlackUserRow = typeof slackUser.$inferSelect;
export type ThreadRow = typeof slackThread.$inferSelect;

const RANK: Record<SlackMemberTier | SlackChannelTier, number> = {
  blocked: 0,
  off: 0,
  relay: 1,
  schedule: 2,
};

/** Whether a tier reaches what an action needs. */
export const reaches = (tier: SlackMemberTier, need: SlackMemberTier) => RANK[tier] >= RANK[need];

/** The lower of a member's tier and a channel's: what Jarvis does for them in its threads. */
export function lowerTier(member: SlackMemberTier, channel: SlackChannelTier): SlackMemberTier {
  if (RANK[channel] === 0) return "blocked";
  return RANK[member] <= RANK[channel] ? member : (channel as SlackMemberTier);
}

/**
 * A name someone chose for themselves, as a member's prompt, a card or a log line shows it:
 * letters, digits, spaces and a little punctuation, short, and never Hearth's link tags. It's
 * still their words, so it never says who they are; their Slack id does.
 */
export function cleanName(name: string | null | undefined, fallback: string): string {
  const kept = named(name ?? "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} .'’-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  return kept || fallback;
}

/** Why someone in Slack is never answered (D62), or null for a full member of your workspace. */
export function notAMember(u: Pick<SlackUserRow, "id" | "bot" | "guest" | "external" | "deleted">) {
  if (u.bot || u.id === "USLACKBOT") return "bot";
  if (u.deleted) return "deactivated";
  if (u.external) return "external";
  if (u.guest) return "guest";
  return null;
}

export interface MemberNow {
  user: SlackUserRow;
  name: string;
  /** What Jarvis does for them here, now: "blocked" when they're blocked or no longer a member. */
  tier: SlackMemberTier;
  /** Whether a reply here waits for your yes: theirs, or the channel's in a thread. */
  replies: SlackReplies;
  thread: ThreadRow | null;
}

/**
 * The member behind a caller, as they are now: their row, their tier (blocked if you blocked them
 * or Slack says they're no longer a full member, lowered to the channel's in a thread) and whether
 * replies to them wait for you. Null for anyone who isn't a member Hearth knows.
 */
export async function memberNow(
  db: DbOrTx,
  caller: Pick<Caller, "kind" | "principal" | "conversationId">,
): Promise<MemberNow | null> {
  if (caller.kind !== "member") return null;
  const [row] = await db
    .select({ user: slackUser, disabledAt: principal.disabledAt })
    .from(slackUser)
    .innerJoin(principal, eq(principal.id, slackUser.principal))
    .where(eq(slackUser.principal, caller.principal));
  if (!row) return null;
  const { user } = row;
  let tier: SlackMemberTier = row.disabledAt || notAMember(user) ? "blocked" : user.tier;
  let replies = user.replies;
  const [thread] = caller.conversationId
    ? await db
        .select()
        .from(slackThread)
        .where(eq(slackThread.conversationId, caller.conversationId))
    : [];
  if (thread?.audience === "channel") {
    const [c] = await db
      .select({ tier: slackChannel.jarvisTier, replies: slackChannel.jarvisReplies })
      .from(slackChannel)
      .where(eq(slackChannel.id, thread.channelId));
    tier = lowerTier(tier, c?.tier ?? "off");
    if (c?.replies !== "auto") replies = "review";
  }
  return { user, name: cleanName(user.name, user.id), tier, replies, thread: thread ?? null };
}

/**
 * The member calling, refused unless their tier reaches `need`. Each member action reads the tier
 * again itself, from who's asking (D62): a turn that started before you changed it can't use the
 * old one.
 */
export async function needTier(ctx: ActionContext, need: SlackMemberTier): Promise<MemberNow> {
  const m = await memberNow(ctx.tx, ctx.caller);
  if (!m) throw new ActionError("forbidden", "Only someone in the owner's Slack can ask this.");
  if (!reaches(m.tier, need))
    throw new ActionError(
      "forbidden",
      need === "schedule"
        ? "The owner hasn't shared their free time with this person."
        : "The owner isn't taking messages from this person through Jarvis.",
    );
  return m;
}
