// How Jarvis's Slack socket is doing (D62), kept on slack_bot the way the pollers keep theirs
// (connector-health.ts, D61) and reported as sync.slack_bot. A round here is a connection: the
// socket says it's connected, and keeps saying so while it is, or that it couldn't connect. It
// counts as failing only after 30 minutes that the worker saw without a connection, longer than
// an update's restart takes, and at once when Slack has revoked it; either way you're told once
// a day (D60).
import { type DbOrTx, slackBot } from "@hearth/db";
import { eq } from "drizzle-orm";
import { type Health, type NextHealth, nextHealth, type Trouble } from "../../connector-health.ts";
import type { BotRow } from "./tokens.ts";

/**
 * Slack's words for "this bot can't connect again until you act": a socket's disconnect reason
 * or an API error. The socket and the sender stop, and wait for new tokens (D62).
 */
export const REVOKED_CODES: ReadonlySet<string> = new Set([
  "link_disabled",
  "invalid_auth",
  "token_revoked",
  "account_inactive",
  "app_uninstalled",
  "tokens_revoked",
]);

const MESSAGES: Record<string, string> = {
  link_disabled: "Slack turned off Socket Mode for Jarvis's app.",
  invalid_auth: "Slack doesn't accept Jarvis's tokens any more.",
  token_revoked: "Jarvis's Slack token was revoked.",
  account_inactive: "Jarvis's Slack app was deactivated.",
  app_uninstalled: "Jarvis's app was uninstalled from the workspace.",
  tokens_revoked: "Jarvis's Slack tokens were revoked.",
};

/** What a code from Slack means for the socket's health. */
export function botTrouble(code: string): Trouble {
  if (REVOKED_CODES.has(code))
    return {
      kind: "revoked",
      message: `${MESSAGES[code]} Paste new tokens in Settings → Slack → Jarvis's bot.`,
    };
  return { kind: "transient", message: `Jarvis's Slack socket is down: ${code}.` };
}

/**
 * Whether this copy of Hearth holds Jarvis's socket (D62): only once members can talk to it
 * (slack.bot.membersOn), and only the install that connected the bot, so a dev copy on a restored
 * database can't take the live events. Only there is the socket's health worth judging. A
 * process that can't tell which install it is (`installId` null) judges it anyway. The socket
 * also waits while Slack has it revoked; its health still says so.
 */
export const holdsSocket = (row: BotRow, membersOn: boolean, installId: string | null) =>
  membersOn && (installId === null || row.installId === installId);

/** The row's health. A bot whose socket hasn't connected yet counts from when you connected it. */
export const botHealth = (row: BotRow): Health => ({
  syncState: row.syncState,
  failures: row.failures,
  failingSince: row.failingSince,
  syncedAt: row.syncedAt ?? row.connectedAt,
});

/** Why the socket isn't connected, and since when the worker has seen it without one. */
export interface BotDown {
  trouble: Trouble;
  /** When this process saw the socket go, or started without one. */
  since: Date;
}

/**
 * Saves how the socket is doing: `down` null while it's connected. Returns what changed, or null
 * when there's no bot or it's revoked: then nothing changes until slack.bot_replace_tokens takes
 * new tokens, whatever the socket says.
 */
export async function saveBotHealth(
  db: DbOrTx,
  teamId: string,
  now: Date,
  down: BotDown | null,
): Promise<NextHealth | null> {
  const [row] = await db.select().from(slackBot).where(eq(slackBot.teamId, teamId));
  if (!row || row.syncState === "revoked") return null;
  const h = botHealth(row);
  // The time down counts from when this process saw the socket go, not from the last hello: after
  // the PC sleeps or the worker restarts that can be hours ago, and three tries failing in the
  // seconds before the Wi-Fi is back would read as half an hour down and buzz your phone (D60).
  // As sync-health's ErrorClock does, failing comes half an hour after that, never sooner (D62).
  if (down && (!h.syncedAt || h.syncedAt < down.since)) h.syncedAt = down.since;
  // And the run of failures starts then, not at the first try to connect again.
  if (down && !h.failingSince) h.failingSince = down.since;
  const next = nextHealth(h, now, down?.trouble ?? null, down === null);
  await db.update(slackBot).set(next.values).where(eq(slackBot.teamId, teamId));
  return next;
}
