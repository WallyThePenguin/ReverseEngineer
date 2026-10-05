// A Slack workspace in memory, for tests. Like Slack, it pages: history newest first, a thread's
// replies oldest first, at most `pageSize` a page. Jarvis's bot is in it too (D62): its tokens,
// what they may do, the hello its socket gets, and its DMs, which only its own token reads. Users
// can be guests, deactivated or from another org, as users.info says. The bot posts only where
// it's been invited, keeps its outbox ids on what it posts, and can be made to fail as Slack does:
// refusing, asking to slow down, or posting without the answer coming back.
import {
  type ReadBackPage,
  SEARCH_PAGE,
  type SlackApi,
  type SlackChannelFacts,
  type SlackConversation,
  SlackError,
  type SlackMatch,
  type SlackMessage,
  type SlackPage,
  type SlackUser,
} from "./api.ts";
import type { SlackBotApi } from "./bot/api.ts";
import { BOT_SCOPES, JARVIS_APP_ID, KEPT_USER_SCOPES, USER_SCOPES } from "./bot/manifest.ts";
import type { Heard } from "./bot/socket.ts";

const after = (ts: string, oldest: string) => Number(ts) > Number(oldest);

/**
 * How the bot's next post goes wrong: "lost_answer" posts it but the answer never comes back (a
 * timeout); "no_answer" fails before Slack has it; a code is Slack refusing it (ratelimited with
 * its Retry-After).
 */
export type PostFault = "lost_answer" | "no_answer" | { code: string; retryAfter?: number };

/** One post the bot made, as Slack received it. */
export interface FakePost {
  channel: string;
  text: string;
  threadTs?: string;
  outboxId?: string;
  ephemeralTo?: string;
}

export class FakeSlack {
  token = "xoxp-1111-2222-test";
  me = "UME";
  conversations: SlackConversation[] = [];
  users = new Map<string, SlackUser>();
  messages = new Map<string, SlackMessage[]>();
  calls: string[] = [];
  /** The next message's time, in seconds. */
  clock = 1_700_000_000;
  /** The most Slack sends in one page, whatever was asked for. */
  pageSize = 1000;
  /** Set to an error code (token_revoked) to have every call fail with it. */
  failWith: string | null = null;
  /**
   * Error codes for some calls only, by what `calls` would note: "replies C1", "history C2". A
   * ratelimited one can say how long to wait.
   */
  failCalls = new Map<string, string | { code: string; retryAfter?: number }>();
  /** Every call Hearth made, of any kind. */
  requests = 0;
  /** What your own token may do, as x-oauth-scopes says: the reading list and the kept writes. */
  scopes: string[] = [...USER_SCOPES, ...KEPT_USER_SCOPES];
  /** Jarvis's bot: its tokens, who it is, what it may do, and the app its socket's hello names. */
  bot = {
    token: "xoxb-1111-2222-bottest",
    appToken: `xapp-1-${JARVIS_APP_ID}-1111-apptest`,
    teamId: "T1",
    userId: "UJARVIS",
    botId: "BJARVIS",
    scopes: [...BOT_SCOPES] as string[],
    appScopes: ["connections:write"],
    helloApp: JARVIS_APP_ID,
  };
  /** The bot's DMs, by who they're with. */
  ims = new Map<string, string>();
  /** How many times search.messages was asked. */
  searches = 0;
  /** Channels as conversations.info and conversations.members show them. */
  channelFacts = new Map<string, SlackChannelFacts>();
  /** Every post the bot made, in order. */
  posts: FakePost[] = [];
  /** What goes wrong with the bot's next posts, one each. */
  postFaults: PostFault[] = [];

  /** `extra`: what else the message carries, like the bot_id of a bot's post. */
  post(
    channel: string,
    user: string,
    text: string,
    threadTs?: string,
    extra: Partial<SlackMessage> = {},
  ): string {
    const ts = `${this.clock++}.000100`;
    const list = this.messages.get(channel) ?? [];
    list.push({ ts, user, text, threadTs, ...extra });
    this.messages.set(channel, list);
    return ts;
  }

  private failIf(call: string) {
    const fail = this.failCalls.get(call);
    if (typeof fail === "string") throw new SlackError(fail);
    if (fail) throw new SlackError(fail.code, fail.retryAfter);
  }

  private page(list: SlackMessage[], cursor: string | undefined, limit: number): SlackPage {
    const from = Number(cursor ?? 0);
    const size = Math.min(limit, this.pageSize);
    const messages = list.slice(from, from + size);
    return { messages, ...(from + size < list.length ? { next: String(from + size) } : {}) };
  }

  /** A thread's start as Slack shows it: with its reply count and newest reply. */
  private withReplies(channel: string, m: SlackMessage): SlackMessage {
    const replies = (this.messages.get(channel) ?? []).filter(
      (r) => r.threadTs === m.ts && r.ts !== m.ts,
    );
    if (!replies.length) return m;
    return { ...m, threadTs: m.ts, replyCount: replies.length, latestReply: replies.at(-1)!.ts };
  }

  /** A page of a place's history, whoever's token reads it. */
  private historyOf(
    channel: string,
    p: { oldest: string; latest?: string; cursor?: string; limit: number },
  ): SlackPage {
    // Like Slack: thread replies aren't in a channel's history.
    const list = (this.messages.get(channel) ?? [])
      .filter(
        (m) =>
          after(m.ts, p.oldest) &&
          (!p.latest || Number(m.ts) < Number(p.latest)) &&
          (!m.threadTs || m.threadTs === m.ts),
      )
      .map((m) => this.withReplies(channel, m))
      .reverse();
    return this.page(list, p.cursor, p.limit);
  }

  /** What's been posted in a place since `oldest` (inclusive), or in one thread, newest first. */
  private readBackOf(channel: string, p: ReadBackPage): SlackMessage[] {
    return (this.messages.get(channel) ?? [])
      .filter((m) => Number(m.ts) >= Number(p.oldest))
      .filter((m) =>
        p.threadTs
          ? m.ts === p.threadTs || m.threadTs === p.threadTs
          : !m.threadTs || m.threadTs === m.ts,
      )
      .reverse();
  }

  /** A channel with the people in it; `bot` invites Jarvis's bot. */
  channel(id: string, name: string, members: string[], more: Partial<SlackChannelFacts> = {}) {
    const kind = id.startsWith("G") ? "private" : "channel";
    this.channelFacts.set(id, { id, name, kind, archived: false, shared: false, members, ...more });
  }

  api(): SlackApi {
    const check = (token: string) => {
      this.requests++;
      if (this.failWith) throw new SlackError(this.failWith);
      if (token !== this.token) throw new SlackError("invalid_auth");
    };
    return {
      whoami: async (token) => {
        check(token);
        return {
          teamId: "T1",
          team: "Acme",
          url: "https://acme.slack.com/",
          userId: this.me,
          scopes: this.scopes,
        };
      },
      conversations: async (token) => {
        check(token);
        return this.conversations;
      },
      history: async (token, channel, p) => {
        check(token);
        this.calls.push(`history ${channel}`);
        this.failIf(`history ${channel}`);
        return this.historyOf(channel, p);
      },
      replies: async (token, channel, threadTs, p) => {
        check(token);
        this.calls.push(`replies ${channel} ${threadTs}`);
        this.failIf(`replies ${channel}`);
        const list = (this.messages.get(channel) ?? []).filter(
          (m) => m.threadTs === threadTs && m.ts !== threadTs && after(m.ts, p.oldest),
        );
        return this.page(list, p.cursor, p.limit);
      },
      user: async (token, id) => {
        check(token);
        return this.users.get(id) ?? null;
      },
      mentions: async (token, userId, page = 1) => {
        check(token);
        this.searches++;
        this.failIf(`search <@${userId}>`);
        const out: SlackMatch[] = [];
        for (const [channel, list] of this.messages)
          for (const m of list) if (m.text.includes(`<@${userId}>`)) out.push({ ...m, channel });
        out.sort((a, b) => Number(b.ts) - Number(a.ts));
        return out.slice((page - 1) * SEARCH_PAGE, page * SEARCH_PAGE);
      },
      users: async (token) => {
        check(token);
        this.calls.push("users.list");
        return [...this.users.values()];
      },
      channel: async (token, id) => {
        check(token);
        this.calls.push(`channel ${id}`);
        this.failIf(`channel ${id}`);
        const facts = this.channelFacts.get(id);
        if (!facts) throw new SlackError("channel_not_found");
        return { ...facts, members: [...facts.members] };
      },
      readBack: async (token, channel, p) => {
        check(token);
        this.calls.push(`readback ${channel}`);
        this.failIf(`readback ${channel}`);
        return this.readBackOf(channel, p);
      },
    };
  }

  /** The bot's side of Slack, which takes only the bot's and the app's tokens. */
  botApi(): SlackBotApi {
    const check = (token: string, want: string, call: string) => {
      this.requests++;
      this.calls.push(`bot ${call}`);
      if (this.failWith) throw new SlackError(this.failWith);
      if (token !== want) throw new SlackError("invalid_auth");
    };
    return {
      whoami: async (token) => {
        check(token, this.bot.token, "auth.test");
        const { teamId, userId, botId, scopes } = this.bot;
        return { teamId, userId, botId, scopes };
      },
      openSocket: async (token) => {
        check(token, this.bot.appToken, "apps.connections.open");
        if (!this.bot.appScopes.includes("connections:write"))
          throw new SlackError("missing_scope");
        return { url: "wss://wss.slack.example/link/?ticket=1", scopes: this.bot.appScopes };
      },
      hello: async () => {
        this.calls.push("bot hello");
        return { appId: this.bot.helloApp };
      },
      openDm: async (token, userId) => {
        check(token, this.bot.token, "conversations.open");
        const id = this.ims.get(userId) ?? `D${userId}`;
        this.ims.set(userId, id);
        return id;
      },
      ims: async (token) => {
        check(token, this.bot.token, "users.conversations");
        return [...this.ims].map(([user, id]) => ({ id, user }));
      },
      history: async (token, channel, p) => {
        check(token, this.bot.token, `history ${channel}`);
        this.failIf(`bot history ${channel}`);
        const page = this.historyOf(channel, p);
        return { messages: page.messages.map((m) => heard(channel, m)), next: page.next };
      },
      post: async (token, msg) => {
        check(token, this.bot.token, `post ${msg.channel}`);
        const fault = this.postFaults.shift();
        if (fault && typeof fault === "object") throw new SlackError(fault.code, fault.retryAfter);
        if (fault === "no_answer") throw new TypeError("fetch failed");
        const channel = /^[UW]/.test(msg.channel)
          ? (this.ims.get(msg.channel) ?? `D${msg.channel}`)
          : msg.channel;
        // Without chat:write.public the bot posts only where it's been invited.
        const facts = this.channelFacts.get(channel);
        if (/^[CG]/.test(channel) && !facts?.members.includes(this.bot.userId))
          throw new SlackError(facts ? "not_in_channel" : "channel_not_found");
        const extra = { botId: this.bot.botId, outboxId: msg.outboxId };
        const ts = this.post(channel, this.bot.userId, msg.text, msg.threadTs, extra);
        this.posts.push({
          channel,
          text: msg.text,
          threadTs: msg.threadTs,
          outboxId: msg.outboxId,
        });
        if (fault === "lost_answer")
          throw new DOMException("The operation timed out.", "TimeoutError");
        return { channel, ts };
      },
      postEphemeral: async (token, msg) => {
        check(token, this.bot.token, `ephemeral ${msg.channel}`);
        this.posts.push({ channel: msg.channel, text: msg.text, ephemeralTo: msg.user });
      },
      readBack: async (token, channel, p) => {
        check(token, this.bot.token, `readback ${channel}`);
        this.failIf(`bot readback ${channel}`);
        return this.readBackOf(channel, p);
      },
    };
  }
}

/** A stored message as the bot's history gives it. */
const heard = (channel: string, m: SlackMessage): Heard => ({
  channel,
  ts: m.ts,
  user: m.user,
  botId: m.botId,
  subtype: m.subtype,
  text: m.text,
  threadTs: m.threadTs,
  teams: [],
});
