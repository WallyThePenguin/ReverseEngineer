// What Hearth asks of Slack as Jarvis's bot (D62): with the bot token (xoxb) and the app-level
// token (xapp), never with your own. Your token can only read (api.ts USER_TOKEN_METHODS); this
// client takes only the bot's and the app's tokens, so nothing Jarvis posts can go out as you.
import { type Raw, SlackError, slackRequest, str } from "../api.ts";

export const SLACK_BOT_SERVICE = "slack_bot";

export interface BotIdentity {
  teamId: string;
  /** The bot's own user (U…): what an @Jarvis names. */
  userId: string;
  /** The bot (B…): what Jarvis's own posts carry. */
  botId: string;
  /** What Slack says the bot token may do (x-oauth-scopes). */
  scopes: string[];
}

export interface SlackBotApi {
  /** auth.test with the bot token: whose bot it is and what it may do. */
  whoami(botToken: string): Promise<BotIdentity>;
  /**
   * apps.connections.open with the app token: an address good for one socket, and the scopes Slack
   * says the app token has.
   */
  openSocket(appToken: string): Promise<{ url: string; scopes: string[] }>;
  /** Connects to that address, waits for Slack's hello and leaves: the app the socket is for. */
  hello(url: string): Promise<{ appId: string }>;
  /** conversations.open with one person: the bot's DM with them. */
  openDm(botToken: string, userId: string): Promise<string>;
}

/** How long Slack has to say hello on a new socket. */
const HELLO_MS = 10_000;

/** Refuses your own token, or one token in the other's place, before anything is sent. */
function only(prefix: "xoxb-" | "xapp-", token: string): string {
  if (!token.startsWith(prefix))
    throw new Error(`Only a ${prefix} token goes here: Hearth never posts with your own (D62).`);
  return token;
}

/**
 * Waits for the first thing a new socket says, which is Slack's hello naming the app. Node's own
 * WebSocket is enough for this one look; the socket that listens (apps/worker) uses `ws`, which
 * sees Slack's pings (D62).
 */
function firstWord(url: string, ms = HELLO_MS): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const done = (fn: () => void) => {
      clearTimeout(timer);
      socket.close();
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new SlackError("no_hello"))), ms);
    socket.addEventListener("message", (e) => {
      let said: Raw | null = null;
      try {
        said = JSON.parse(String(e.data)) as Raw;
      } catch {}
      done(() => (said ? resolve(said) : reject(new SlackError("no_hello"))));
    });
    socket.addEventListener("error", () =>
      done(() => reject(new SlackError("socket_unreachable"))),
    );
  });
}

/** Slack's real Web API for the bot, over HTTPS. */
export function httpSlackBot(base = "https://slack.com/api"): SlackBotApi {
  return {
    async whoami(botToken) {
      const { body: r, scopes } = await slackRequest(
        base,
        only("xoxb-", botToken),
        "auth.test",
        {},
      );
      return {
        teamId: String(r.team_id),
        userId: String(r.user_id),
        botId: String(r.bot_id ?? ""),
        scopes,
      };
    },
    async openSocket(appToken) {
      const { body: r, scopes } = await slackRequest(
        base,
        only("xapp-", appToken),
        "apps.connections.open",
        {},
        true,
      );
      return { url: String(r.url), scopes };
    },
    async hello(url) {
      const said = await firstWord(url);
      // A refused socket says why instead: link_disabled, or the app's tokens revoked.
      if (said.type === "disconnect") throw new SlackError(str(said.reason) ?? "disconnect");
      if (said.type !== "hello") throw new SlackError("no_hello");
      const info = (said.connection_info as Raw | undefined) ?? {};
      return { appId: str(info.app_id) ?? "" };
    },
    async openDm(botToken, userId) {
      const { body: r } = await slackRequest(
        base,
        only("xoxb-", botToken),
        "conversations.open",
        { users: userId },
        true,
      );
      return String((r.channel as Raw | undefined)?.id ?? "");
    },
  };
}
