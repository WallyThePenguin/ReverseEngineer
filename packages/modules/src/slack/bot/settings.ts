// What you decide about Jarvis's bot (D62): whether people in your workspace can talk to it at
// all (slack.bot.membersOn, off at first), and whether its replies to them go out on their own.
// That second switch is a standing rule for slack.reply held by member:slack:<team>:*, the
// wildcard for every member of the team. Only this owner-only action writes it, so nothing Jarvis
// reads can turn it on. It starts on, so a member's DM gets its answer without waiting from day
// one; channel replies still wait for your yes, because channels start on review (the owner's
// answers, 2026-10-05).
import { memberPrincipal } from "@hearth/core";
import { type DbOrTx, principal, standingRule } from "@hearth/db";
import { type ActionContext, defineAction, getSetting, newId, setSetting } from "@hearth/kernel";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { workspace } from "./tokens.ts";

/** The action a member turn's answer goes out through, held to the switch above. */
export const REPLY_ACTION = "slack.reply";

const ruleFor = (teamId: string) =>
  and(
    eq(standingRule.action, REPLY_ACTION),
    eq(standingRule.principal, memberPrincipal(teamId, "*")),
  );

/** Whether Jarvis's replies to members go out without your yes. */
export async function answersOnOwn(db: DbOrTx, teamId: string): Promise<boolean> {
  const rows = await db.select({ id: standingRule.id }).from(standingRule).where(ruleFor(teamId));
  return rows.length > 0;
}

/**
 * Makes the principal for every member of the team, the first time. True when it's new, which
 * is how connecting knows to start the switch on only once: turning it off sticks, even through
 * disconnecting and connecting again.
 */
export async function ensureMemberWildcard(
  ctx: ActionContext,
  teamId: string,
  teamName: string,
): Promise<boolean> {
  const made = await ctx.tx
    .insert(principal)
    .values({
      id: memberPrincipal(teamId, "*"),
      kind: "member",
      displayName: `Everyone in ${teamName}`,
    })
    .onConflictDoNothing()
    .returning({ id: principal.id });
  return made.length > 0;
}

export async function setAnswersOnOwn(
  ctx: ActionContext,
  teamId: string,
  teamName: string,
  on: boolean,
) {
  if (!on) {
    await ctx.tx.delete(standingRule).where(ruleFor(teamId));
    return;
  }
  await ensureMemberWildcard(ctx, teamId, teamName);
  await ctx.tx
    .insert(standingRule)
    .values({
      id: newId(),
      action: REPLY_ACTION,
      principal: memberPrincipal(teamId, "*"),
      note: "The Jarvis bot answers Slack members on its own, unless they or their channel are on review.",
      createdAt: ctx.now,
    })
    .onConflictDoNothing();
}

export const botSettingsAction = defineAction({
  name: "slack.bot_settings",
  description:
    "Whether people in your Slack workspace can talk to the Jarvis bot, and whether its replies to them go out without your yes.",
  input: z.object({
    membersOn: z.boolean().optional(),
    answersOnOwn: z.boolean().optional(),
    /** What your own DM to Jarvis gets back in Slack: fixed replies, or the answer itself. */
    ownerDmAnswers: z.enum(["fixed", "full"]).optional(),
  }),
  risk: "internal",
  // Only you: this is what lets a member's reply go out without asking (D62), and what decides
  // whether Jarvis's answers to you are kept in Slack.
  callers: ["owner"],
  async handler(i, ctx) {
    const ws = await workspace(ctx);
    if (i.membersOn !== undefined) await setSetting(ctx.tx, "slack.bot.membersOn", i.membersOn);
    if (i.answersOnOwn !== undefined)
      await setAnswersOnOwn(ctx, ws.teamId, ws.teamName, i.answersOnOwn);
    if (i.ownerDmAnswers !== undefined)
      await setSetting(ctx.tx, "slack.bot.ownerDmAnswers", i.ownerDmAnswers);
    return {
      membersOn: await getSetting(ctx.tx, "slack.bot.membersOn"),
      answersOnOwn: await answersOnOwn(ctx.tx, ws.teamId),
      ownerDmAnswers: await getSetting(ctx.tx, "slack.bot.ownerDmAnswers"),
    };
  },
});
