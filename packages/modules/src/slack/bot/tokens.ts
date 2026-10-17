// Jarvis's bot token and app token (D62), sealed with the vault key like your own Slack token,
// each under its own name: "<team>:bot" and "<team>:app". A token moved into the other's column
// won't open, so a mix-up in the database can't put the app token where the bot's goes, or back.
import { type slackBot, slackChannel, slackWorkspace } from "@hearth/db";
import { type ActionContext, ActionError } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { VAULT_SERVICE, type Vault } from "../../browser/vault.ts";
import { SLACK_BOT_SERVICE, type SlackBotApi } from "./api.ts";

export type BotRow = typeof slackBot.$inferSelect;
export type BotTokenKind = "bot" | "app";

type Services = Pick<ActionContext, "service">;

const vault = (ctx: Services) => ctx.service<Vault>(VAULT_SERVICE);

export const botApi = (ctx: Services) => ctx.service<SlackBotApi>(SLACK_BOT_SERVICE);

export const sealBotToken = (ctx: Services, teamId: string, kind: BotTokenKind, token: string) =>
  vault(ctx).seal("slack.com", `${teamId}:${kind}`, token);

/** Opens the bot's token or the app's. Only the worker does, to listen and to post (D62). */
export function openBotToken(ctx: Services, row: BotRow, kind: BotTokenKind): string {
  try {
    return vault(ctx).open(
      "slack.com",
      `${row.teamId}:${kind}`,
      kind === "bot" ? row.botToken : row.appToken,
    );
  } catch {
    throw new ActionError(
      "failed",
      "The Jarvis bot's Slack tokens can't be opened. Paste them again in Settings → Slack.",
    );
  }
}

/** The workspace your own token reads: the bot must be in it. */
export async function workspace(ctx: ActionContext) {
  const [ws] = await ctx.tx.select().from(slackWorkspace).limit(1);
  if (!ws)
    throw new ActionError("not_found", "Connect Slack with your own token first, then the bot.");
  return ws;
}

/**
 * The bot's tokens as given in Settings, refused by shape before anything is sent: your own
 * token pasted as the bot's is named, since Hearth never posts as you.
 */
export function tokenIssue(kind: BotTokenKind, t: string): string | null {
  if (kind === "bot") {
    if (/^xox[pe]-/.test(t))
      return "That's your own user token (xoxp-). The bot token is the Bot User OAuth Token, which starts with xoxb-.";
    if (!/^xoxb-[A-Za-z0-9-]{10,290}$/.test(t))
      return "The bot token starts with xoxb-: copy the Bot User OAuth Token under OAuth & Permissions.";
    return null;
  }
  if (!/^xapp-\d+-[A-Z0-9]+-[A-Za-z0-9-]{6,250}$/.test(t))
    return "The app token starts with xapp-: make one under Basic Information → App-Level Tokens.";
  return null;
}

/** The app an app-level token belongs to, which it names: xapp-1-A0C0RPY4WKV-… */
export const appOfToken = (t: string) => /^xapp-\d+-([A-Z0-9]+)-/.exec(t)?.[1] ?? null;

/** The channel row of your DM with the bot stops being read in: Jarvis's words aren't news. */
export async function stopReadingOwnerIm(ctx: ActionContext, ownerIm: string) {
  await ctx.tx.update(slackChannel).set({ ingest: false }).where(eq(slackChannel.id, ownerIm));
}
