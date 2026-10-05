// The screens for Jarvis in your Slack (D62): Activity's Slack filter, a member conversation's
// name and bar, where Reply as Jarvis goes, and Ask Jarvis about this.
import { describe, expect, it } from "vitest";
import { affectedBy, touches } from "./invalidate.ts";
import {
  askAbout,
  isMemberConversation,
  isSlackTurn,
  pausedNow,
  placeOf,
  replyAsJarvis,
  type SlackConversation,
} from "./slack.ts";

const sam = {
  id: "USAM",
  name: "Sam Lee",
  tier: "relay" as const,
  replies: "auto" as const,
  vip: false,
  notAMember: null,
  member: true,
};
const dm: SlackConversation = {
  id: "0190a000-0000-7000-8000-000000000001",
  title: "Slack: Sam Lee",
  lastAt: null,
  place: "dm",
  channel: null,
  people: [sam],
  threadTs: null,
  pausedUntil: null,
  waiting: 0,
  heldReplies: 0,
};
const thread: SlackConversation = {
  ...dm,
  id: "0190a000-0000-7000-8000-000000000002",
  title: "Slack: #launch",
  place: "channel",
  channel: { id: "C1", name: "launch", tier: "relay", replies: "review" },
  people: [{ ...sam, member: false }],
  threadTs: "1700000000.000100",
};

describe("Jarvis in Slack, on the screens", () => {
  it("filters Jarvis's activity to what Slack started: members, and you in your DM", () => {
    expect(isSlackTurn({ trigger: "slack_member" })).toBe(true);
    expect(isSlackTurn({ trigger: "chat", context: { via: "slack" } })).toBe(true);
    expect(isSlackTurn({ trigger: "chat", context: {} })).toBe(false);
    expect(isSlackTurn({ trigger: "mention", context: null })).toBe(false);
  });

  it("shows a member's conversation read-only, named for who and where", () => {
    expect(isMemberConversation("slack_member")).toBe(true);
    expect(isMemberConversation("slack")).toBe(false);
    expect(isMemberConversation(null)).toBe(false);
    expect(placeOf(dm)).toBe("Sam Lee's DM with Jarvis");
    expect(placeOf(thread)).toBe("A thread in #launch");
  });

  it("replies as Jarvis where the conversation is: their DM, or the thread it was asked in", () => {
    expect(replyAsJarvis(dm, "  On it.  ")).toEqual({
      action: "slack.dm",
      input: { to: "USAM", text: "On it." },
    });
    expect(replyAsJarvis(thread, "Thanks, all")).toEqual({
      action: "slack.post_in_channel",
      input: { channelId: "C1", text: "Thanks, all", threadTs: "1700000000.000100" },
    });
    expect(replyAsJarvis(dm, "   ")).toBeNull();
  });

  it("asks Jarvis about it in a new conversation that mentions this one", () => {
    expect(askAbout(dm.id)).toBe(
      `What should I know about <m-ref type="conversation" id="${dm.id}">this Slack conversation</m-ref>?`,
    );
  });

  it("knows a pause that's over from one that isn't", () => {
    const now = Date.parse("2026-10-05T14:00:00Z");
    expect(pausedNow({ pausedUntil: "2026-10-05T15:00:00Z" }, now)).toBe(true);
    expect(pausedNow({ pausedUntil: "2026-10-05T13:00:00Z" }, now)).toBe(false);
    expect(pausedNow({ pausedUntil: null }, now)).toBe(false);
  });

  it("refreshes the Slack screens when a member's conversation grows", () => {
    const rule = affectedBy({ kind: "conversation.appended", payload: {} });
    expect(rule && touches(rule, ["slack.conversations", {}])).toBe(true);
    expect(rule && touches(rule, ["slack.conversation", { id: dm.id }])).toBe(true);
  });
});
