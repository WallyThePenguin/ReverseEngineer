// Connecting Slack, giving it a new token, and letting it go. A new token for the same workspace
// keeps everything read in so far (D61): only disconnecting removes it.
import { entity, slackBot, slackMessage, slackUser, slackWorkspace } from "@hearth/db";
import { type ActionContext, ActionError, defineAction } from "@hearth/kernel";
import { and, eq, inArray, ne, not } from "drizzle-orm";
import { z } from "zod";
import { closeAlerts } from "../connector-health.ts";
import { SlackError } from "./api.ts";
import { slackManifest, USER_SCOPES } from "./bot/manifest.ts";
import { settleUnsent, waitForTakeRounds } from "./bot/not-sent.ts";
import { decidedAbout } from "./member/people.ts";
import { sealToken, slackApi, type WorkspaceRow } from "./save.ts";

/** What a Slack app for Hearth needs (user token scopes), shown in Settings. */
export const SLACK_SCOPES: string[] = [...USER_SCOPES];

const token = z
  .string()
  .trim()
  .regex(/^xox[pe]-[A-Za-z0-9-]{10,300}$/);

async function whoami(ctx: ActionContext, t: string) {
  try {
    return await slackApi(ctx).whoami(t);
  } catch (err) {
    throw new ActionError(
      "invalid_input",
      err instanceof SlackError ? err.message : "Slack couldn't be reached.",
    );
  }
}

type Me = Awaited<ReturnType<typeof whoami>>;

/** Swaps in a new token for the same person in the same workspace, and syncing starts again. */
async function replace(ctx: ActionContext, ws: WorkspaceRow, me: Me, t: string) {
  if (me.teamId !== ws.teamId)
    throw new ActionError(
      "invalid_input",
      `That token is for ${me.team}, not ${ws.teamName}. Disconnect ${ws.teamName} first to switch workspaces.`,
    );
  if (me.userId !== ws.userId)
    throw new ActionError(
      "invalid_input",
      "That token belongs to someone else in the workspace. Copy your own User OAuth Token.",
    );
  await ctx.tx
    .update(slackWorkspace)
    .set({
      token: sealToken(ctx, ws.teamId, t),
      teamName: me.team,
      url: me.url,
      syncState: "ok",
      failures: 0,
      failingSince: null,
      lastError: null,
    })
    .where(eq(slackWorkspace.teamId, ws.teamId));
  await closeAlerts(ctx, "slack");
  return { team: me.team, url: me.url };
}

const current = async (ctx: ActionContext) =>
  (await ctx.tx.select().from(slackWorkspace).limit(1))[0];

export const connectActions = [
  defineAction({
    name: "slack.connect",
    description: "Connect your Slack workspace with a Slack app's User OAuth Token (xoxp-...).",
    input: z.object({ token }),
    // Only you, from Settings; the audit log keeps none of it.
    risk: "secret",
    callers: ["owner"],
    async handler(i, ctx) {
      const me = await whoami(ctx, i.token);
      // One workspace. The same one again just takes the new token and keeps what's read in.
      const ws = await current(ctx);
      if (ws) return replace(ctx, ws, me, i.token);
      await ctx.tx.insert(slackWorkspace).values({
        teamId: me.teamId,
        teamName: me.team,
        url: me.url,
        userId: me.userId,
        token: sealToken(ctx, me.teamId, i.token),
      });
      // What you decided about people in another workspace isn't about anyone here: a kept
      // person with the same Slack id mustn't come back with their tier or VIP (D62). Someone you
      // blocked stays blocked, though, and only that: in an Enterprise Grid org, their id is the
      // same here.
      const elsewhere = ne(slackUser.teamId, me.teamId);
      await ctx.tx
        .update(slackUser)
        .set({ teamId: me.teamId, replies: "auto", vip: false })
        .where(and(elsewhere, eq(slackUser.tier, "blocked")));
      await ctx.tx.delete(slackUser).where(elsewhere);
      return { team: me.team, url: me.url };
    },
  }),
  defineAction({
    name: "slack.replace_token",
    description:
      "Give Hearth a new Slack token for the connected workspace (after the old one was revoked or expired), keeping everything read in so far.",
    input: z.object({ token }),
    risk: "secret",
    callers: ["owner"],
    async handler(i, ctx) {
      const ws = await current(ctx);
      if (!ws) throw new ActionError("not_found", "Slack isn't connected.");
      return replace(ctx, ws, await whoami(ctx, i.token), i.token);
    },
  }),
  defineAction({
    name: "slack.status",
    description:
      "Whether Slack is connected, which workspace, how syncing is going, and the manifest for your Slack app.",
    input: z.object({}),
    risk: "read",
    callers: ["owner"],
    async handler(_i, ctx) {
      const [ws] = await ctx.tx
        .select({
          team: slackWorkspace.teamName,
          url: slackWorkspace.url,
          syncedAt: slackWorkspace.syncedAt,
          lastError: slackWorkspace.lastError,
          state: slackWorkspace.syncState,
        })
        .from(slackWorkspace)
        .limit(1);
      // Your name as Slack shows it, when it's been read in, says whose assistant Jarvis is.
      const [me] = await ctx.tx
        .select({ name: slackUser.name })
        .from(slackUser)
        .innerJoin(slackWorkspace, eq(slackWorkspace.userId, slackUser.id))
        .limit(1);
      return {
        connected: Boolean(ws),
        ...(ws ?? {}),
        scopes: SLACK_SCOPES,
        manifest: slackManifest(me?.name ?? null),
      };
    },
  }),
  defineAction({
    name: "slack.disconnect",
    description:
      "Forget the Slack workspace: its token, channels and messages leave Hearth, and so does Jarvis's bot. What you decided for each person stays for when you connect it again.",
    input: z.object({}),
    risk: "internal",
    callers: ["owner"],
    async handler(_i, ctx) {
      await waitForTakeRounds(ctx);
      const ws = await current(ctx);
      // Jarvis's bot goes too: what it hadn't sent is settled first, and you're told about each,
      // before its outbox goes with the workspace (D62).
      let left = { unsent: 0, unsure: 0 };
      if (ws) {
        await ctx.tx.delete(slackBot).where(eq(slackBot.teamId, ws.teamId));
        left = await settleUnsent(ctx, ws.teamId, {
          unsent: "You disconnected Slack.",
          unsure: "You disconnected Slack before it said whether it went out.",
        });
      }
      const ids = ctx.tx.select({ id: slackMessage.entityId }).from(slackMessage);
      await ctx.tx.delete(entity).where(inArray(entity.id, ids));
      // Not the people you've decided about: connecting again mustn't put someone you set to
      // review back on answers that go out on their own (D62).
      await ctx.tx.delete(slackUser).where(not(decidedAbout()));
      await ctx.tx.delete(slackWorkspace);
      await closeAlerts(ctx, "slack");
      return { disconnected: true, ...left };
    },
  }),
];
