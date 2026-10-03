// A Slack workspace in memory, for tests.
import {
  type SlackApi,
  type SlackConversation,
  SlackError,
  type SlackMatch,
  type SlackMessage,
  type SlackUser,
} from "./api.ts";

export class FakeSlack {
  token = "xoxp-1111-2222-test";
  me = "UME";
  conversations: SlackConversation[] = [];
  users = new Map<string, SlackUser>();
  messages = new Map<string, SlackMessage[]>();
  calls: string[] = [];
  /** The next message's time, in seconds. */
  clock = 1_700_000_000;

  post(channel: string, user: string, text: string, threadTs?: string): string {
    const ts = `${this.clock++}.000100`;
    const list = this.messages.get(channel) ?? [];
    list.push({ ts, user, text, threadTs });
    this.messages.set(channel, list);
    return ts;
  }

  api(): SlackApi {
    const check = (token: string) => {
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
      history: async (token, channel, oldest, limit) => {
        check(token);
        this.calls.push(`history ${channel}`);
        // Like Slack: thread replies aren't in a channel's history.
        return (this.messages.get(channel) ?? [])
          .filter((m) => Number(m.ts) > Number(oldest) && (!m.threadTs || m.threadTs === m.ts))
          .slice(-limit);
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
