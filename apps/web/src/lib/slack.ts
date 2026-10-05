// What the screens need to know about Jarvis in your Slack (D62), kept apart from the views so it's
// tested: which turns Slack started, how a member's conversation is named, where a reply as Jarvis
// goes, and how "Ask Jarvis about this" asks without putting your turn in their conversation.

/** Who Jarvis goes how far for: a member's tier, or a channel's. */
export type SlackTier = "blocked" | "off" | "relay" | "schedule";

/** One of Jarvis's conversations in Slack, as slack.conversations gives it. */
export interface SlackConversation {
  id: string;
  title: string;
  lastAt: string | null;
  place: "dm" | "channel";
  channel: { id: string; name: string; tier: SlackTier; replies: "auto" | "review" } | null;
  people: {
    id: string;
    name: string;
    tier: SlackTier;
    replies: "auto" | "review";
    vip: boolean;
    notAMember: string | null;
    /** The member whose DM it is. */
    member: boolean;
  }[];
  threadTs: string | null;
  pausedUntil: string | null;
  waiting: number;
  heldReplies: number;
}

/** A conversation only a Slack member's turns write to: you read it, and act from its bar. */
export const MEMBER_CONVERSATION = "slack_member";
export const isMemberConversation = (startedVia: string | null | undefined) =>
  startedVia === MEMBER_CONVERSATION;

/** A turn Slack started: someone in your workspace, or you in your DM with Jarvis. */
export function isSlackTurn(t: { trigger: string; context?: Record<string, unknown> | null }) {
  return t.trigger === "slack_member" || t.context?.via === "slack";
}

/** Where it is, in words: "Sam Lee's DM" or "A thread in #launch". */
export function placeOf(c: SlackConversation): string {
  if (c.place === "channel") return `A thread in #${c.channel?.name ?? "a channel"}`;
  const who = c.people.find((p) => p.member) ?? c.people[0];
  return who ? `${who.name}'s DM with Jarvis` : "A DM with Jarvis";
}

/** Whether it's paused now. */
export const pausedNow = (c: Pick<SlackConversation, "pausedUntil">, now = Date.now()) =>
  Boolean(c.pausedUntil && Date.parse(c.pausedUntil) > now);

/**
 * Your reply as Jarvis, as one of your own sends: their DM with the bot, or the thread Jarvis was
 * asked in. It goes out like any send of yours (D62), and lands in this conversation.
 */
export function replyAsJarvis(
  c: SlackConversation,
  text: string,
): { action: "slack.dm" | "slack.post_in_channel"; input: Record<string, string> } | null {
  const said = text.trim();
  if (!said) return null;
  if (c.place === "channel") {
    if (!c.channel || !c.threadTs) return null;
    return {
      action: "slack.post_in_channel",
      input: { channelId: c.channel.id, text: said, threadTs: c.threadTs },
    };
  }
  const who = c.people.find((p) => p.member);
  return who ? { action: "slack.dm", input: { to: who.id, text: said } } : null;
}

/**
 * "Ask Jarvis about this": a new conversation of yours that mentions this one, so Jarvis reads it
 * there (and that conversation is marked as having read outside content), never your turn in theirs.
 */
export function askAbout(conversationId: string): string {
  return `What should I know about <m-ref type="conversation" id="${conversationId}">this Slack conversation</m-ref>?`;
}

/** How long a pause from the bar lasts. */
export const PAUSES: { hours: number; label: string }[] = [
  { hours: 1, label: "Pause for an hour" },
  { hours: 8, label: "Pause for 8 hours" },
  { hours: 24, label: "Pause for a day" },
];

export const TIER_LABEL: Record<SlackTier, string> = {
  blocked: "Blocked",
  off: "Off",
  relay: "Pass messages on",
  schedule: "Also share free time",
};
