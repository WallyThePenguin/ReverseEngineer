// What Hearth needs from Slack's Web API, read with your own user token (PLAN.md section 8.3).
// Hearth runs on your PC with no public address, so it asks Slack for news instead of being
// told: one channel at a time, within Slack's rate limits. With your token it only ever reads
// (USER_TOKEN_METHODS); Jarvis posts as its own bot (bot/api.ts, D62).
import { directoryReads, messageOf, userOf } from "./directory.ts";

export { OUTBOX_EVENT } from "./directory.ts";

export const SLACK_SERVICE = "slack";

/**
 * The only Web API methods Hearth calls with your own token, all of them reads. Your app keeps the
 * user write scopes it already had (chat:write, im:write, reactions:write) because something else
 * of yours may use them, so Slack would accept a post made with your token. This list is what
 * keeps Hearth from ever making one (D62).
 */
export const USER_TOKEN_METHODS: ReadonlySet<string> = new Set([
  "auth.test",
  "users.conversations",
  "conversations.history",
  "conversations.replies",
  "users.info",
  "search.messages",
  // Who's who and who's in a channel, for "tell Sam" (D62).
  "users.list",
  "conversations.info",
  "conversations.members",
]);

/** Refuses, before anything is sent, any call with your own token that isn't one of those reads. */
export function assertUserRead(method: string): void {
  if (!USER_TOKEN_METHODS.has(method))
    throw new Error(`Hearth never calls ${method} with your own Slack token: it only reads (D62).`);
}

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
  /** On a post Jarvis's outbox made: the outbox row it came from (OUTBOX_EVENT metadata). */
  outboxId?: string;
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
  /** Their full name, as their profile gives it (`name` is what they go by). */
  realName?: string;
  email?: string;
  bot: boolean;
  /** A guest (single- or multi-channel): never answered by Jarvis (D62). */
  guest?: boolean;
  /** Deactivated. */
  deleted?: boolean;
  /** Their own workspace: another org's for a Slack Connect user. */
  teamId?: string;
  /** For a bot's user: the app it belongs to, and the bot (B…). */
  appId?: string;
  botId?: string;
}

export interface SlackMatch extends SlackMessage {
  channel: string;
}

/** A channel as your token sees it (conversations.info and conversations.members). */
export interface SlackChannelFacts {
  id: string;
  name: string;
  kind: SlackConversation["kind"];
  archived: boolean;
  /** Shared with another org (Slack Connect), or about to be. */
  shared: boolean;
  /** Everyone in it, by id: Jarvis's bot too, once it's been invited. */
  members: string[];
}

/** Where to read back from: a place since `oldest`, or one thread in it. */
export interface ReadBackPage {
  oldest: string;
  threadTs?: string;
}

/** How many matches a page of search holds. */
export const SEARCH_PAGE = 50;

export interface SlackApi {
  /** Who the token belongs to, and the scopes Slack says it has (x-oauth-scopes). */
  whoami(
    token: string,
  ): Promise<{ teamId: string; team: string; url: string; userId: string; scopes: string[] }>;
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
  /**
   * Recent messages that @mention this user, anywhere, thread replies included: newest first, a
   * page of SEARCH_PAGE at a time (page 1 is the newest).
   */
  mentions(token: string, userId: string, page?: number): Promise<SlackMatch[]>;
  /** Everyone in the workspace (users.list), bots and deactivated users included. */
  users(token: string): Promise<SlackUser[]>;
  /** A channel, and who's in it. */
  channel(token: string, id: string): Promise<SlackChannelFacts>;
  /**
   * What's been posted in a channel since `oldest`, with the outbox id on each of Jarvis's posts:
   * how the outbox tells whether a post that may have gone out did (D62).
   */
  readBack(token: string, channel: string, page: ReadBackPage): Promise<SlackMessage[]>;
  /**
   * A thread as it stands, its first message included: the last `limit` messages, oldest first.
   * What a channel turn sees of the thread it answers in (D62).
   */
  thread(token: string, channel: string, threadTs: string, limit: number): Promise<SlackMessage[]>;
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

export type Raw = Record<string, unknown>;

export const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** The scopes Slack says a token has, from the header it sends back with every answer. */
export const scopesOf = (headers: Headers): string[] =>
  (headers.get("x-oauth-scopes") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * One Web API call: the parameters in the address, or posted as a form. Slack's answer, and the
 * scopes it says the token has.
 */
export async function slackRequest(
  base: string,
  token: string,
  method: string,
  params: Record<string, string>,
  post = false,
): Promise<{ body: Raw; scopes: string[] }> {
  const form = new URLSearchParams(params);
  const res = await fetch(post ? `${base}/${method}` : `${base}/${method}?${form}`, {
    method: post ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(post ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(post ? { body: form } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 429)
    throw new SlackError("ratelimited", Number(res.headers.get("retry-after") ?? 60));
  const body = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as Raw;
  if (!body.ok) throw new SlackError(String(body.error ?? "unknown_error"));
  return { body, scopes: scopesOf(res.headers) };
}

/** The cursor for the next page, when Slack says there's more. */
const nextCursor = (r: Raw): string | undefined =>
  (r.has_more ? str((r.response_metadata as Raw | undefined)?.next_cursor) : undefined) ||
  undefined;

/** Slack's real Web API, over HTTPS, with your own token: reads only. */
export function httpSlack(base = "https://slack.com/api"): SlackApi {
  // Every call with your token goes through here, so nothing but a read is ever sent (D62).
  const read = (token: string, method: string, params: Record<string, string>) => {
    assertUserRead(method);
    return slackRequest(base, token, method, params);
  };
  const call = async (token: string, method: string, params: Record<string, string>) =>
    (await read(token, method, params)).body;
  return {
    async whoami(token) {
      const { body: r, scopes } = await read(token, "auth.test", {});
      return {
        teamId: String(r.team_id),
        team: String(r.team ?? ""),
        url: String(r.url ?? ""),
        userId: String(r.user_id),
        scopes,
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
      return { messages: ((r.messages as Raw[]) ?? []).map(messageOf), next: nextCursor(r) };
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
      const messages = ((r.messages as Raw[]) ?? []).map(messageOf);
      // Slack puts the thread's first message at the top of every page.
      return { messages: messages.filter((m) => m.ts !== threadTs), next: nextCursor(r) };
    },
    async user(token, id) {
      try {
        const r = await call(token, "users.info", { user: id });
        return userOf(r.user as Raw, id);
      } catch (err) {
        if (err instanceof SlackError && err.code === "user_not_found") return null;
        throw err;
      }
    },
    async mentions(token, userId, page = 1) {
      const r = await call(token, "search.messages", {
        query: `<@${userId}>`,
        sort: "timestamp",
        sort_dir: "desc",
        count: String(SEARCH_PAGE),
        page: String(page),
      });
      const matches = ((r.messages as Raw | undefined)?.matches as Raw[]) ?? [];
      return matches.map((m) => {
        const permalink = str(m.permalink) ?? "";
        const thread = /thread_ts=([0-9.]+)/.exec(permalink)?.[1];
        return {
          ...messageOf(m),
          threadTs: thread,
          channel: String((m.channel as Raw | undefined)?.id ?? ""),
        };
      });
    },
    ...directoryReads((token) => (method, params) => call(token, method, params)),
  };
}
