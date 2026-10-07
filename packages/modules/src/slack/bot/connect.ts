// Connecting Jarvis's own Slack bot (D62): its bot token (xoxb) to post as Jarvis, and an
// app-level token (xapp) to listen over Socket Mode, because Hearth has no public address. Only you
// can, from Settings, and only once both tokens prove to be app A0C0RPY4WKV's in your workspace,
// with the scopes the manifest asks for. Nothing about them reaches the audit log (risk secret).
import { slackBot, slackWorkspace } from "@hearth/db";
import { type ActionContext, ActionError, defineAction, getSetting } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { INSTALL_SERVICE, type Install } from "../../install.ts";
import { SlackError } from "../api.ts";
import { openToken, slackApi, type WorkspaceRow } from "../save.ts";
import {
  APP_TOKEN_SCOPE,
  BOT_SCOPES,
  checkScopes,
  JARVIS_APP_ID,
  KEPT_USER_SCOPES,
  USER_SCOPES,
} from "./manifest.ts";
import { settleUnsent, waitForTakeRounds } from "./not-sent.ts";
import {
  answersOnOwn,
  botSettingsAction,
  ensureMemberWildcard,
  setAnswersOnOwn,
} from "./settings.ts";
import {
  appOfToken,
  type BotRow,
  type BotTokenKind,
  botApi,
  sealBotToken,
  stopReadingOwnerIm,
  tokenIssue,
  workspace,
} from "./tokens.ts";

const token = (kind: BotTokenKind) =>
  z
    .string()
    .trim()
    .max(300)
    .superRefine((t, c) => {
      const issue = tokenIssue(kind, t);
      if (issue) c.addIssue({ code: "custom", message: issue });
    });

const tokens = z.object({ botToken: token("bot"), appToken: token("app") });
type Tokens = z.output<typeof tokens>;

const NEEDS_CONNECTIONS = `The app token needs the ${APP_TOKEN_SCOPE} scope. Make one with it under Basic Information → App-Level Tokens.`;

const refuse = (message: string): never => {
  throw new ActionError("invalid_input", message);
};

/** One question to Slack, with what its refusal means in words. */
async function ask<T>(
  what: string,
  call: () => Promise<T>,
  meanings: Record<string, string> = {},
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof ActionError) throw err;
    if (err instanceof SlackError)
      return refuse(meanings[err.code] ?? `Slack refused ${what} (${err.code}).`);
    throw new ActionError("failed", "Slack couldn't be reached. Try again in a minute.");
  }
}

interface Verified {
  botUserId: string;
  botId: string;
  ownerIm: string;
  warnings: string[];
}

/**
 * Proves the tokens before anything is saved: the app token is Jarvis's app's, by its own name
 * and by the hello on a socket it opens; the bot is in the workspace your token reads; both
 * tokens, and yours, have the scopes the manifest asks for. Then the bot opens its DM with you.
 */
async function verify(ctx: ActionContext, ws: WorkspaceRow, i: Tokens): Promise<Verified> {
  const app = appOfToken(i.appToken);
  if (app !== JARVIS_APP_ID)
    refuse(
      `That app token is for app ${app}, not Jarvis's (${JARVIS_APP_ID}). Make it in that app, under Basic Information → App-Level Tokens.`,
    );
  const api = botApi(ctx);
  const bot = await ask("the bot token", () => api.whoami(i.botToken));
  if (bot.teamId !== ws.teamId)
    refuse(
      `That bot is in another Slack workspace, not ${ws.teamName}. Copy the bot token from Jarvis's app in ${ws.teamName}.`,
    );
  if (!bot.botId) refuse("That token isn't a bot's. Copy the Bot User OAuth Token.");
  const botScopes = checkScopes(bot.scopes, BOT_SCOPES);
  if (botScopes.missing.length)
    refuse(
      `The bot token is missing ${botScopes.missing.join(", ")}. Merge in the manifest, reinstall the app, and copy its bot token again.`,
    );
  // Your own token's reading list too, since catching up on @Jarvis reads with it. Its kept
  // write scopes are no concern: Hearth never writes with it (D62).
  const mine = await ask("your own token", () => slackApi(ctx).whoami(openToken(ctx, ws)));
  const yours = checkScopes(mine.scopes, USER_SCOPES, KEPT_USER_SCOPES);
  if (yours.missing.length)
    refuse(
      `Your own Slack token is missing ${yours.missing.join(", ")}. Merge in the manifest, reinstall the app, and paste its new User OAuth Token under Slack → New token.`,
    );
  // The bot is Jarvis's app's too, not another bot in the workspace: its user's profile says whose.
  const botUser = await ask("your own token", () =>
    slackApi(ctx).user(openToken(ctx, ws), bot.userId),
  );
  if (botUser?.appId !== JARVIS_APP_ID || botUser.botId !== bot.botId)
    refuse(
      `That bot token is for ${botUser?.appId ? `app ${botUser.appId}` : "another app"}, not Jarvis's (${JARVIS_APP_ID}). Copy the Bot User OAuth Token from Jarvis's app.`,
    );
  const socket = await ask("the app token", () => api.openSocket(i.appToken), {
    missing_scope: NEEDS_CONNECTIONS,
  });
  if (socket.scopes.length && !socket.scopes.includes(APP_TOKEN_SCOPE)) refuse(NEEDS_CONNECTIONS);
  const hello = await ask("Jarvis's socket", () => api.hello(socket.url));
  if (hello.appId !== JARVIS_APP_ID)
    refuse(
      `Slack says that socket is for app ${hello.appId || "(none)"}, not Jarvis's (${JARVIS_APP_ID}).`,
    );
  // The only place a message to Jarvis can be yours (D62).
  const ownerIm = await ask("the bot token", () => api.openDm(i.botToken, ws.userId));
  if (!ownerIm) refuse("Slack didn't open the bot's DM with you. Try again in a minute.");
  const warnings = botScopes.extra.length
    ? [
        `The bot has scopes Hearth doesn't use: ${botScopes.extra.join(", ")}. Remove them from the app unless something else needs them; anyone holding the bot token could use them.`,
      ]
    : [];
  return { botUserId: bot.userId, botId: bot.botId, ownerIm, warnings };
}

/** Seals and saves the tokens, records this install as the one that listens, and starts afresh. */
async function save(ctx: ActionContext, ws: WorkspaceRow, v: Verified, i: Tokens) {
  const values = {
    appId: JARVIS_APP_ID,
    botUserId: v.botUserId,
    botId: v.botId,
    ownerIm: v.ownerIm,
    installId: ctx.service<Install>(INSTALL_SERVICE).id(),
    botToken: sealBotToken(ctx, ws.teamId, "bot", i.botToken),
    appToken: sealBotToken(ctx, ws.teamId, "app", i.appToken),
    // New tokens start their health over, so the 30 minutes before "failing" count from now.
    connectedAt: ctx.now,
    syncState: "ok" as const,
    failures: 0,
    failingSince: null,
    lastError: null,
    syncedAt: null,
  };
  await ctx.tx
    .insert(slackBot)
    .values({ teamId: ws.teamId, ...values })
    .onConflictDoUpdate({ target: slackBot.teamId, set: values });
  await stopReadingOwnerIm(ctx, v.ownerIm);
}

async function connect(ctx: ActionContext, ws: WorkspaceRow, i: Tokens) {
  const v = await verify(ctx, ws, i);
  await save(ctx, ws, v, i);
  return { team: ws.teamName, botUser: v.botUserId, warnings: v.warnings };
}

const current = async (ctx: ActionContext, teamId: string): Promise<BotRow | undefined> =>
  (await ctx.tx.select().from(slackBot).where(eq(slackBot.teamId, teamId)))[0];

/** Whether this copy of Hearth is the one that listens; null in a process that can't tell. */
function listensHere(ctx: ActionContext, bot: BotRow): boolean | null {
  try {
    return ctx.service<Install>(INSTALL_SERVICE).id() === bot.installId;
  } catch {
    return null;
  }
}

export const botActions = [
  defineAction({
    name: "slack.bot_connect",
    description:
      "Connect Jarvis's own Slack bot with its Bot User OAuth Token (xoxb-…) and an App-Level Token (xapp-…).",
    input: tokens,
    risk: "secret",
    callers: ["owner"],
    async handler(i, ctx) {
      const ws = await workspace(ctx);
      const done = await connect(ctx, ws, i);
      // The first time ever, members' DM replies go out on their own (the owner's answers,
      // 2026-10-05). Turned off later, it stays off through a reconnect.
      if (await ensureMemberWildcard(ctx, ws.teamId, ws.teamName))
        await setAnswersOnOwn(ctx, ws.teamId, ws.teamName, true);
      return done;
    },
  }),
  defineAction({
    name: "slack.bot_replace_tokens",
    description:
      "Give Jarvis's Slack bot new tokens (after Slack revoked them), keeping its conversations.",
    input: tokens,
    risk: "secret",
    callers: ["owner"],
    async handler(i, ctx) {
      const ws = await workspace(ctx);
      if (!(await current(ctx, ws.teamId)))
        throw new ActionError("not_found", "Jarvis's bot isn't connected.");
      return connect(ctx, ws, i);
    },
  }),
  defineAction({
    name: "slack.bot_disconnect",
    description:
      "Forget Jarvis's Slack bot: its tokens leave Hearth and it stops listening. Its conversations stay.",
    input: z.object({}),
    risk: "secret",
    callers: ["owner"],
    async handler(_i, ctx) {
      await waitForTakeRounds(ctx);
      const ws = await workspace(ctx);
      await ctx.tx.delete(slackBot).where(eq(slackBot.teamId, ws.teamId));
      // What it hadn't sent is settled now, and you're told about each (D62).
      const left = await settleUnsent(ctx, ws.teamId, {
        unsent: "Jarvis's bot was disconnected.",
        unsure: "Jarvis's bot was disconnected before Slack said whether it went out.",
      });
      return { disconnected: true, ...left };
    },
  }),
  defineAction({
    name: "slack.bot_status",
    description:
      "Whether Jarvis's Slack bot is connected, how its socket is doing, and whether members can talk to it.",
    input: z.object({}),
    // A read: it shows no token, and your own reads of it skip the audit log (D56).
    risk: "read",
    callers: ["owner"],
    async handler(_i, ctx) {
      const membersOn = await getSetting(ctx.tx, "slack.bot.membersOn");
      const ownerDmAnswers = await getSetting(ctx.tx, "slack.bot.ownerDmAnswers");
      const [ws] = await ctx.tx.select().from(slackWorkspace).limit(1);
      const bot = ws ? await current(ctx, ws.teamId) : undefined;
      const answers = ws ? await answersOnOwn(ctx.tx, ws.teamId) : false;
      if (!ws || !bot)
        return {
          connected: false,
          appId: JARVIS_APP_ID,
          membersOn,
          answersOnOwn: answers,
          ownerDmAnswers,
        };
      return {
        connected: true,
        appId: bot.appId,
        team: ws.teamName,
        botUser: bot.botUserId,
        state: bot.syncState,
        lastError: bot.lastError,
        connectedAt: bot.connectedAt,
        syncedAt: bot.syncedAt,
        listensHere: listensHere(ctx, bot),
        membersOn,
        answersOnOwn: answers,
        ownerDmAnswers,
      };
    },
  }),
  botSettingsAction,
];
