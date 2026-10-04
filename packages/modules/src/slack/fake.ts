// A Slack workspace in memory, for tests. Like Slack, it pages: history newest first, a thread's
// replies oldest first, at most `pageSize` a page.
import {
  type SlackApi,
  type SlackConversation,
  SlackError,
  type SlackMatch,
  type SlackMessage,
  type SlackPage,
  type SlackUser,
} from "./api.ts";

const after = (ts: string, oldest: string) => Number(ts) > Number(oldest);

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
  /** Error codes for some calls only, by what `calls` would note: "replies C1", "history C2". */
  failCalls = new Map<string, string>();
  /** Every call Hearth made, of any kind. */
  requests = 0;

  post(channel: string, user: string, text: string, threadTs?: string): string {
    const ts = `${this.clock++}.000100`;
    const list = this.messages.get(channel) ?? [];
    list.push({ ts, user, text, threadTs });
    this.messages.set(channel, list);
    return ts;
  }

  private failIf(call: string) {
    const code = this.failCalls.get(call);
    if (code) throw new SlackError(code);
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

  api(): SlackApi {
    const check = (token: string) => {
      this.requests++;
      if (this.failWith) throw new SlackError(this.failWith);
      if (token !== this.token) throw new SlackError("invalid_auth");
    };
    return {
      whoami: async (token) => {
        check(token);
        return { teamId: "T1", team: "Acme", url: "https://acme.slack.com/", userId: this.me };
      },
      conversations: async (token) => {
        check(token);
        return this.conversations;
      },
      history: async (token, channel, p) => {
        check(token);
        this.calls.push(`history ${channel}`);
        this.failIf(`history ${channel}`);
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
      mentions: async (token, userId) => {
        check(token);
        const out: SlackMatch[] = [];
        for (const [channel, list] of this.messages)
          for (const m of list) if (m.text.includes(`<@${userId}>`)) out.push({ ...m, channel });
        return out.reverse();
      },
    };
  }
}
