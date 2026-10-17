// What you decide about the people in your Slack (D62), in Settings: who Jarvis answers and how
// far (blocked, relay, or schedule, which shares your free time and takes meeting requests),
// whose replies wait for your yes, whose urgent messages may interrupt you, and the answers you've
// written down to share. Only you call these (`callers: ["owner"]`), so nothing Jarvis reads can
// widen what a member gets or mark something shareable. Everyone starts at relay, with replies
// that go out on their own; schedule is yours to give, one person at a time (the owner's answers).
import { memberPrincipal } from "@hearth/core";
import {
  conversation,
  principal,
  slackAnswer,
  slackInbound,
  slackThread,
  slackUser,
} from "@hearth/db";
import { type ActionContext, ActionError, defineAction, newId } from "@hearth/kernel";
import { and, desc, eq, inArray, max } from "drizzle-orm";
import { z } from "zod";
import { workspace } from "../bot/tokens.ts";
import { openToken, slackApi } from "../save.ts";
import { cleanName, decidedAbout, notAMember } from "./people.ts";

const userId = z.string().regex(/^[UW][A-Z0-9]{2,40}$/, "A Slack user id, like U012ABCDEF.");

/** The most a shared answer says; a member's prompt holds 4 KB of them in all. */
export const ANSWER_MAX = 4000;

/** Someone you're deciding about, looked up in Slack if Hearth hasn't met them yet. */
async function userRow(ctx: ActionContext, id: string) {
  const [had] = await ctx.tx.select().from(slackUser).where(eq(slackUser.id, id));
  if (had) return had;
  const ws = await workspace(ctx);
  const u = await slackApi(ctx).user(openToken(ctx, ws), id);
  if (!u) throw new ActionError("not_found", `No one in Slack has the id ${id}.`);
  const [made] = await ctx.tx
    .insert(slackUser)
    .values({
      id,
      teamId: ws.teamId,
      name: (u.realName || u.name).slice(0, 200),
      email: u.email?.toLowerCase() ?? null,
      bot: u.bot,
      guest: Boolean(u.guest),
      external: Boolean(u.teamId && u.teamId !== ws.teamId),
      deleted: Boolean(u.deleted),
      checkedAt: ctx.now,
    })
    .onConflictDoNothing()
    .returning();
  return made ?? (await ctx.tx.select().from(slackUser).where(eq(slackUser.id, id)))[0]!;
}

export const ownerMemberActions = [
  defineAction({
    name: "slack.members",
    description:
      "The people in your Slack the Jarvis bot knows of: who has written to it, and anyone you've set. Each with their full name, email, Slack id, tier, whether replies wait for you, and VIP.",
    input: z.object({}),
    risk: "read",
    // Names and emails of people in your workspace: Settings is the only reader.
    callers: ["owner"],
    async handler(_i, ctx) {
      const rows = await ctx.tx
        .select({ user: slackUser, wrote: max(slackInbound.receivedAt) })
        .from(slackUser)
        .leftJoin(slackInbound, eq(slackInbound.userId, slackUser.id))
        .where(decidedAbout())
        .groupBy(slackUser.id)
        .orderBy(desc(max(slackInbound.receivedAt)), slackUser.name);
      return rows.map(({ user: u, wrote }) => ({
        id: u.id,
        name: cleanName(u.name, u.id),
        email: u.email,
        tier: u.tier,
        replies: u.replies,
        vip: u.vip,
        // Why Jarvis never answers them, whatever their tier.
        notAMember: notAMember(u),
        checkedAt: u.checkedAt,
        lastWrote: wrote,
      }));
    },
  }),
  defineAction({
    name: "slack.member_set",
    description:
      "Set what the Jarvis bot does for someone in your Slack: their tier (blocked, relay, or schedule to share your free time), whether its replies to them wait for your yes, and VIP.",
    input: z.object({
      user: userId,
      tier: z.enum(["blocked", "relay", "schedule"]).optional(),
      replies: z.enum(["auto", "review"]).optional(),
      vip: z.boolean().optional(),
    }),
    risk: "internal",
    callers: ["owner"],
    async handler(i, ctx) {
      const u = await userRow(ctx, i.user);
      const why = notAMember(u);
      if (why && i.tier && i.tier !== "blocked")
        throw new ActionError(
          "invalid_input",
          `The Jarvis bot never answers ${cleanName(u.name, u.id)}: they're ${why === "bot" ? "a bot" : why === "external" ? "in another org" : why === "guest" ? "a guest" : "deactivated"}.`,
        );
      const patch = {
        ...(i.tier ? { tier: i.tier } : {}),
        ...(i.replies ? { replies: i.replies } : {}),
        ...(i.vip !== undefined ? { vip: i.vip } : {}),
      };
      if (i.tier) {
        // Blocking also disables their principal, so no call of theirs runs, even one waiting
        // for your yes (D62); unblocking gives it back.
        const id = memberPrincipal(u.teamId, u.id);
        const name = cleanName(u.name, u.id);
        await ctx.tx
          .insert(principal)
          .values({ id, kind: "member", displayName: `${name} on Slack` })
          .onConflictDoNothing();
        await ctx.tx
          .update(principal)
          .set({ disabledAt: i.tier === "blocked" ? ctx.now : null })
          .where(and(eq(principal.id, id), eq(principal.kind, "member")));
        Object.assign(patch, { principal: id });
      }
      const [row] = Object.keys(patch).length
        ? await ctx.tx.update(slackUser).set(patch).where(eq(slackUser.id, u.id)).returning()
        : [u];
      // Their DM's next turn starts afresh: a session kept from before carries what the old tier
      // let it read (your free time, say) and replies you held, as if they'd been sent (D62).
      if ((i.tier && i.tier !== u.tier) || (i.replies && i.replies !== u.replies))
        await ctx.tx
          .update(conversation)
          .set({ agentSessionId: null })
          .where(
            inArray(
              conversation.entityId,
              ctx.tx
                .select({ id: slackThread.conversationId })
                .from(slackThread)
                .where(eq(slackThread.member, memberPrincipal(u.teamId, u.id))),
            ),
          );
      return {
        id: row!.id,
        name: cleanName(row!.name, row!.id),
        tier: row!.tier,
        replies: row!.replies,
        vip: row!.vip,
      };
    },
  }),
  defineAction({
    name: "slack.answers",
    description:
      "The answers you've written for the Jarvis bot to share with people in your Slack: office hours, status, how to reach you. Each is for everyone or for named people.",
    input: z.object({}),
    risk: "read",
    callers: ["owner"],
    handler: (_i, ctx) => ctx.tx.select().from(slackAnswer).orderBy(slackAnswer.createdAt),
  }),
  defineAction({
    name: "slack.answer_save",
    description:
      "Write or change an answer the Jarvis bot may share with people in your Slack. `users` names who it's for by Slack id; leave it out for everyone.",
    input: z.object({
      id: z.string().uuid().optional(),
      title: z.string().trim().max(200).default(""),
      body: z.string().trim().min(1).max(ANSWER_MAX),
      users: z.array(userId).min(1).max(100).nullable().default(null),
    }),
    risk: "internal",
    // Only you mark something shareable (D62).
    callers: ["owner"],
    async handler(i, ctx) {
      const ws = await workspace(ctx);
      const values = { title: i.title, body: i.body, users: i.users, updatedAt: ctx.now };
      if (i.id) {
        const [row] = await ctx.tx
          .update(slackAnswer)
          .set(values)
          .where(eq(slackAnswer.id, i.id))
          .returning();
        if (!row) throw new ActionError("not_found", "No such shared answer.");
        return row;
      }
      const [row] = await ctx.tx
        .insert(slackAnswer)
        .values({ id: newId(), teamId: ws.teamId, createdAt: ctx.now, ...values })
        .returning();
      return row!;
    },
  }),
  defineAction({
    name: "slack.answer_delete",
    description: "Stop sharing one of your written answers with people in your Slack.",
    input: z.object({ id: z.string().uuid() }),
    risk: "internal",
    callers: ["owner"],
    async handler(i, ctx) {
      const gone = await ctx.tx
        .delete(slackAnswer)
        .where(eq(slackAnswer.id, i.id))
        .returning({ id: slackAnswer.id });
      if (!gone.length) throw new ActionError("not_found", "No such shared answer.");
      return { deleted: true };
    },
  }),
];
