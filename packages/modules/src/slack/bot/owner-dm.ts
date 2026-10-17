// Your own DM with Jarvis's bot (D62). It's you, but untrusted and via Slack, like the desktop app
// (D42): the worker takes what you wrote there as you (`ownerCaller("slack", { origin:
// "untrusted" })`), through chat.send, so it's a chat turn with all your tools in which anything
// outward or self_external waits for your yes in Hearth. Your messages go to one rolling
// conversation, started via Slack; after 12 quiet hours the next one starts a new conversation.
//
// A message is yours only if all four say so: Slack's user is your own id (slack_workspace), it's
// in the bot's DM with you (owner_im), it's a plain message (the socket already drops anything
// with a bot_id or an app_id, and here a subtype is refused too), and it's from your workspace.
// A lookalike name, your id in another channel, or a post an app made as you is not you.
//
// Slack gets only fixed replies: "Got it, it's in Hearth: <link>", then "Done" or "Needs your yes
// in Hearth" when the turn ends. A pasted answer is an outward channel, and Slack keeps and
// exports it, so the answer itself goes there only if you choose (`slack.bot.ownerDmAnswers`).
import {
  conversation,
  entity,
  jarvisTurn,
  slackBot,
  slackInbound,
  slackThread,
  slackWorkspace,
} from "@hearth/db";
import { type ActionContext, ActionError, defineAction, getSetting } from "@hearth/kernel";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { INSTALL_SERVICE, type Install } from "../../install.ts";
import { type InboundRow, plainOf, settle } from "../member/messages.ts";
import { enqueue } from "./queue.ts";

/** Taken once it's been stored this long, like a member's: a burst arrives together. */
const SETTLE_MS = 1_500;
/** After this long quiet, your next DM starts a new conversation. */
export const OWNER_DM_IDLE_MS = 12 * 3_600_000;
const PER_ROUND = 20;

/** Everything Slack hears back from Hearth about your DM, unless you turned full answers on. */
export const OWNER_REPLIES = {
  got: (link: string) => `Got it, it's in Nook: ${link}`,
  done: "Done",
  ask: "Needs your yes in Nook",
  failed: "That didn't work. It's in Nook.",
} as const;

type Ws = typeof slackWorkspace.$inferSelect;
type Bot = typeof slackBot.$inferSelect;

/** The four checks (D62): your id, your DM with the bot, a plain message, your workspace. */
export function isYou(
  row: Pick<InboundRow, "userId" | "channelId" | "subtype" | "teamId">,
  ws: Pick<Ws, "userId" | "teamId">,
  bot: Pick<Bot, "ownerIm" | "teamId">,
): boolean {
  return (
    row.userId === ws.userId &&
    row.channelId === bot.ownerIm &&
    !row.subtype &&
    row.teamId === ws.teamId &&
    bot.teamId === ws.teamId
  );
}

/** A link to a conversation in Hearth, at the address you open it on. */
export function hearthLink(ctx: Pick<ActionContext, "service">, conversationId: string) {
  let origin = "http://localhost:4400";
  try {
    origin = ctx.service<Install>(INSTALL_SERVICE).origin?.() ?? origin;
  } catch {
    // No install service here: the local address will do.
  }
  return `${origin}/chat/${conversationId}`;
}

/** The rolling conversation, while it's live and has been used in the last 12 hours. */
async function rolling(ctx: ActionContext, bot: Bot): Promise<string | null> {
  const [t] = await ctx.tx
    .select({
      id: slackThread.conversationId,
      deletedAt: entity.deletedAt,
      at: conversation.lastTurnAt,
    })
    .from(slackThread)
    .innerJoin(entity, eq(entity.id, slackThread.conversationId))
    .innerJoin(conversation, eq(conversation.entityId, slackThread.conversationId))
    .where(
      and(
        eq(slackThread.channelId, bot.ownerIm),
        eq(slackThread.threadTs, ""),
        eq(slackThread.audience, "owner"),
      ),
    );
  const quiet = !t?.at || t.at.getTime() < ctx.now.getTime() - OWNER_DM_IDLE_MS;
  if (!t || t.deletedAt || quiet) return null;
  return t.id;
}

/** Points your DM at the conversation it now goes to, keeping catch-up's mark. */
async function keep(ctx: ActionContext, bot: Bot, conversationId: string) {
  await ctx.tx
    .insert(slackThread)
    .values({
      channelId: bot.ownerIm,
      threadTs: "",
      teamId: bot.teamId,
      conversationId,
      audience: "owner",
      createdAt: ctx.now,
    })
    .onConflictDoUpdate({
      target: [slackThread.channelId, slackThread.threadTs],
      set: { conversationId, audience: "owner", member: null },
    });
}

export const takeOwnerAction = defineAction({
  name: "slack.take_owner",
  description:
    "Take what you wrote to the Jarvis bot in your own Slack DM: each message goes to Pip as you, untrusted, in a conversation started via Slack.",
  input: z.object({}),
  risk: "internal",
  callers: ["owner"],
  auditWhen: (r: { taken: number }) => r.taken > 0,
  async handler(_i, ctx) {
    // Only as you via Slack, untrusted: taken any other way, Slack's words would run as yours.
    if (ctx.caller.via !== "slack" || ctx.caller.origin !== "untrusted")
      throw new ActionError("forbidden", "Your Slack DM is taken as you via Slack, untrusted.");
    await ctx.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('slack_take_owner'))`);
    const [ws] = await ctx.tx.select().from(slackWorkspace).limit(1);
    const [bot] = ws
      ? await ctx.tx.select().from(slackBot).where(eq(slackBot.teamId, ws.teamId))
      : [];
    if (!ws || !bot) return { taken: 0 };
    const rows = await ctx.tx
      .select()
      .from(slackInbound)
      .where(
        and(
          isNull(slackInbound.takenAt),
          eq(slackInbound.channelId, bot.ownerIm),
          lte(slackInbound.receivedAt, new Date(ctx.now.getTime() - SETTLE_MS)),
        ),
      )
      .orderBy(sql`${slackInbound.ts}::numeric`)
      .limit(PER_ROUND)
      .for("update", { skipLocked: true });
    let taken = 0;
    for (const row of rows) {
      const text = (await plainOf(ctx.tx, row.text)).trim();
      if (!isYou(row, ws, bot) || !text) {
        await settle(ctx, [row], isYou(row, ws, bot) ? "ignored:empty" : "ignored:not_you");
        continue;
      }
      const had = await rolling(ctx, bot);
      const sent = await ctx.call<{ conversationId: string }>("chat.send", {
        ...(had ? { conversationId: had } : {}),
        text,
      });
      if (sent.conversationId !== had) await keep(ctx, bot, sent.conversationId);
      await ctx.tx
        .update(slackInbound)
        .set({ conversationId: sent.conversationId })
        .where(and(eq(slackInbound.channelId, row.channelId), eq(slackInbound.ts, row.ts)));
      await settle(ctx, [row], "yours");
      await enqueue(ctx, {
        dedupeKey: `owner:got:${row.ts}`,
        teamId: bot.teamId,
        channelId: bot.ownerIm,
        threadTs: row.threadTs,
        text: OWNER_REPLIES.got(hearthLink(ctx, sent.conversationId)),
        kind: "note",
        conversationId: sent.conversationId,
      });
      taken++;
    }
    return { taken };
  },
});

export const ownerReplyAction = defineAction({
  name: "slack.owner_reply",
  description:
    "Tell you in your Slack DM with the Jarvis bot how a turn you started there ended: Done, or Needs your yes in Nook.",
  input: z.object({
    turnId: z.string().uuid(),
    ended: z.enum(["done", "ask", "failed"]),
    /** What Jarvis said, sent only when you turned full answers on. */
    answer: z.string().max(20_000).nullable().default(null),
  }),
  risk: "internal",
  // Only Jarvis's runner, as the system, when a turn ends (D62).
  callers: ["system"],
  async handler(i, ctx) {
    const [turn] = await ctx.tx.select().from(jarvisTurn).where(eq(jarvisTurn.id, i.turnId));
    if (turn?.trigger !== "chat" || turn.context.via !== "slack") return { sent: false };
    const [bot] = await ctx.tx.select().from(slackBot).limit(1);
    if (!bot) return { sent: false };
    const full = (await getSetting(ctx.tx, "slack.bot.ownerDmAnswers")) === "full";
    const text =
      full && i.ended === "done" && i.answer?.trim() ? i.answer.trim() : OWNER_REPLIES[i.ended];
    const { created } = await enqueue(ctx, {
      // One a turn, however often it's told.
      dedupeKey: `owner:end:${turn.id}`,
      teamId: bot.teamId,
      channelId: bot.ownerIm,
      text,
      // A fixed reply is a note; your answer itself goes through the filter like your own sends.
      kind: text === i.answer?.trim() ? "send" : "note",
      conversationId: turn.conversationId,
      turnId: turn.id,
    });
    return { sent: created, full: full && text !== OWNER_REPLIES[i.ended] };
  },
});
