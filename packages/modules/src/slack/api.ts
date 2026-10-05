// What Hearth needs from Slack's Web API, read with your own user token (PLAN.md section 8.3).
// Hearth runs on your PC with no public address, so it asks Slack for news instead of being
// told: one channel at a time, within Slack's rate limits.

export const SLACK_SERVICE = "slack";

export interface SlackMessage {
  ts: string;
  user?: string;
  /** A bot or an app. */
  botId?: string;
  text: string;
  threadTs?: string;
  /** Join, leave, topic changes and the like. */
  subtype?: string;
  /** A thread's start: how many replies it has, and the newest one's ts. */
  replyCount?: number;
  latestReply?: string;
}

/** One page of messages, and the cursor for the next page when there's more. */
export interface SlackPage {
  messages: SlackMessage[];
  next?: string;
}

export interface SlackConversation {
  id: string;
  name: string;
  kind: "channel" | "private" | "group" | "dm";
  /** For a direct message: who it's with. */
  user?: string;
}

export interface SlackUser {
  id: string;
  name: string;
  email?: string;
  bot: boolean;
}

export interface SlackMatch extends SlackMessage {
  channel: string;
}

export interface SlackApi {
  /** Who the token belongs to. */
  whoami(token: string): Promise<{ teamId: string; team: string; url: string; userId: string }>;
  conversations(token: string): Promise<SlackConversation[]>;
  /**
   * A page of a channel's messages after `oldest` and before `latest` (Slack ts), newest first;
   * the next page is older. Thread replies aren't in it.
   */
  history(
    token: string,
    channel: string,
    page: { oldest: string; latest?: string; cursor?: string; limit: number },
  ): Promise<SlackPage>;
  /** A page of a thread's replies after `oldest`, oldest first, without its first message. */
  replies(
    token: string,
    channel: string,
    threadTs: string,
    page: { oldest: string; cursor?: string; limit: number },
  ): Promise<SlackPage>;
  user(token: string, id: string): Promise<SlackUser | null>;
  /** Recent messages that @mention this user, anywhere, thread replies included. */
  mentions(token: string, userId: string): Promise<SlackMatch[]>;
}

/** Slack said no. `retryAfter` is set when it asks Hearth to slow down. */
export class SlackError extends Error {
  readonly code: string;
  readonly retryAfter?: number;
  constructor(code: string, retryAfter?: number) {
    super(SLACK_ERRORS[code] ?? `Slack answered ${code}.`);
    this.code = code;
    this.retryAfter = retryAfter;
    this.name = "SlackError";
  }
  /** The token no longer works: syncing stops until you connect again. */
  get revoked(): boolean {
    return REVOKED.includes(this.code);
  }
}

const REVOKED = [
  "invalid_auth",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "not_authed",
];

const SLACK_ERRORS: Record<string, string> = {
  invalid_auth: "Slack doesn't accept this token. Copy the User OAuth Token again.",
  token_revoked: "The Slack token was revoked. Paste a new one in Settings.",
  token_expired: "The Slack token expired. Paste a new one in Settings.",
  account_inactive: "That Slack account is deactivated.",
  not_authed: "No Slack token was sent.",
  missing_scope: "The Slack app is missing a permission. Add the scopes listed in Settings.",
  ratelimited: "Slack asked Hearth to slow down; it will carry on in a minute.",
};

type Raw = Record<string, unknown>;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function message(m: Raw): SlackMessage {
  return {
    ts: String(m.ts),
    user: str(m.user),
    botId: str(m.bot_id),
    text: str(m.text) ?? "",
    threadTs: str(m.thread_ts),
    subtype: str(m.subtype),
    replyCount: typeof m.reply_count === "number" ? m.reply_count : undefined,
    latestReply: str(m.latest_reply),
  };
}

/** The cursor for the next page, when Slack says there's more. */
const nextCursor = (r: Raw): string | undefined =>
  (r.has_more ? str((r.response_metadata as Raw | undefined)?.next_cursor) : undefined) ||
  undefined;

/** Slack's real Web API, over HTTPS. */
export function httpSlack(base = "https://slack.com/api"): SlackApi {
  async function call(token: string, method: string, params: Record<string, string>) {
    const res = await fetch(`${base}/${method}?${new URLSearchParams(params)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429)
      throw new SlackError("ratelimited", Number(res.headers.get("retry-after") ?? 60));
    const body = (await res
      .json()
      .catch(() => ({ ok: false, error: `http_${res.status}` }))) as Raw;
    if (!body.ok) throw new SlackError(String(body.error ?? "unknown_error"));
    return body;
  }
  return {
    async whoami(token) {
      const r = await call(token, "auth.test", {});
      return {
        teamId: String(r.team_id),
        team: String(r.team ?? ""),
        url: String(r.url ?? ""),
        userId: String(r.user_id),
      };
    },
    async conversations(token) {
      const out: SlackConversation[] = [];
      let cursor = "";
      for (let page = 0; page < 20; page++) {
        const r = await call(token, "users.conversations", {
          types: "public_channel,private_channel,mpim,im",
          exclude_archived: "true",
          limit: "200",
          ...(cursor ? { cursor } : {}),
        });
        for (const c of (r.channels as Raw[]) ?? []) {
          const kind = c.is_im ? "dm" : c.is_mpim ? "group" : c.is_private ? "private" : "channel";
          out.push({ id: String(c.id), name: str(c.name) ?? "", kind, user: str(c.user) });
        }
        cursor = str((r.response_metadata as Raw | undefined)?.next_cursor) ?? "";
        if (!cursor) break;
      }
      return out;
    },
    async history(token, channel, page) {
      const r = await call(token, "conversations.history", {
        channel,
        oldest: page.oldest,
        ...(page.latest ? { latest: page.latest } : {}),
        ...(page.cursor ? { cursor: page.cursor } : {}),
        limit: String(page.limit),
        inclusive: "false",
      });
      return { messages: ((r.messages as Raw[]) ?? []).map(message), next: nextCursor(r) };
    },
    async replies(token, channel, threadTs, page) {
      const r = await call(token, "conversations.replies", {
        channel,
        ts: threadTs,
        oldest: page.oldest,
        ...(page.cursor ? { cursor: page.cursor } : {}),
        limit: String(page.limit),
        inclusive: "false",
      });
      const messages = ((r.messages as Raw[]) ?? []).map(message);
      // Slack puts the thread's first message at the top of every page.
      return { messages: messages.filter((m) => m.ts !== threadTs), next: nextCursor(r) };
    },
    async user(token, id) {
      try {
        const r = await call(token, "users.info", { user: id });
        const u = r.user as Raw;
        const profile = (u.profile as Raw | undefined) ?? {};
        return {
          id,
          name: str(profile.display_name) || str(u.real_name) || str(u.name) || id,
          email: str(profile.email),
          bot: Boolean(u.is_bot),
        };
      } catch (err) {
        if (err instanceof SlackError && err.code === "user_not_found") return null;
        throw err;
      }
    },
    async mentions(token, userId) {
      const r = await call(token, "search.messages", {
        query: `<@${userId}>`,
        sort: "timestamp",
        sort_dir: "desc",
        count: "50",
      });
      const matches = ((r.messages as Raw | undefined)?.matches as Raw[]) ?? [];
      return matches.map((m) => {
        const permalink = str(m.permalink) ?? "";
        const thread = /thread_ts=([0-9.]+)/.exec(permalink)?.[1];
        return {
          ...message(m),
          threadTs: thread,
          channel: String((m.channel as Raw | undefined)?.id ?? ""),
        };
      });
    },
  };
}
