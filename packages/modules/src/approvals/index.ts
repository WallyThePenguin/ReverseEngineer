// Approvals and standing rules. Deciding an approval is owner-only and goes through the
// kernel directly (POST /api/approvals/:id), so it's not an action any agent can call.
import { asUntrusted, PRINCIPAL } from "@hearth/core";
import { approval, standingRule, type Tx } from "@hearth/db";
import { ActionError, type DigestItem, defineAction, defineModule, newId } from "@hearth/kernel";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { id, writtenOutside } from "../shared.ts";

/** Never from a card's Always allow: email waits for your yes, card after card (D70). */
const NEVER_ALWAYS = ["mail.send"];

/** Writes Jarvis's rule for an action, or for its one place or person, and returns it. */
async function writeRule(tx: Tx, rule: { action: string; target: string; note: string }, at: Date) {
  const [row] = await tx
    .insert(standingRule)
    .values({ id: newId(), principal: PRINCIPAL.jarvis, createdAt: at, ...rule })
    .onConflictDoUpdate({
      target: [standingRule.action, standingRule.principal, standingRule.target],
      set: { note: rule.note },
    })
    .returning();
  return row!;
}

export const approvalsModule = defineModule({
  name: "approvals",
  description: "Things waiting for your yes, and the standing rules that let Jarvis skip asking.",
  entityTypes: [],
  events: [],
  kernelEvents: ["approval.requested", "approval.resolved"],
  knowledge: {},
  actions: [
    defineAction({
      name: "approval.list",
      description: "List approvals, pending ones by default.",
      input: z.object({
        status: z
          .enum(["pending", "executing", "denied", "executed", "failed", "expired"])
          .default("pending"),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      risk: "read",
      async handler(i, ctx) {
        return ctx.tx
          .select()
          .from(approval)
          .where(eq(approval.status, i.status))
          .orderBy(i.status === "pending" ? asc(approval.createdAt) : desc(approval.createdAt))
          .limit(i.limit);
      },
    }),
    defineAction({
      name: "standing_rule.list",
      description: "List the actions Jarvis may take without asking.",
      input: z.object({}),
      risk: "read",
      handler: (_i, ctx) => ctx.tx.select().from(standingRule).orderBy(asc(standingRule.action)),
    }),
    defineAction({
      name: "standing_rule.create",
      description:
        "Let Jarvis take an action without asking. Never applies to work triggered by outside content.",
      input: z.object({ action: z.string().min(3), note: z.string().max(500).default("") }),
      risk: "internal",
      callers: ["owner"],
      handler: (i, ctx) =>
        writeRule(ctx.tx, { action: i.action, target: "", note: i.note }, ctx.now),
    }),
    defineAction({
      name: "standing_rule.always_allow",
      description:
        "Always allow, from an approval card: Jarvis may do what it asked, in that one place or to that one person, without asking again (D70). Only for a request from a conversation you started.",
      input: z.object({ approvalId: id }),
      risk: "internal",
      callers: ["owner"],
      async handler(i, ctx) {
        const [a] = await ctx.tx.select().from(approval).where(eq(approval.id, i.approvalId));
        if (!a) throw new ActionError("not_found", "That request is gone.");
        // Only a card from a turn you started: nothing an email or a message set off makes one.
        if (
          !a.alwaysAllow ||
          a.origin !== "owner" ||
          a.requestedBy !== PRINCIPAL.jarvis ||
          NEVER_ALWAYS.includes(a.action)
        )
          throw new ActionError(
            "forbidden",
            "Always allow is only for what Jarvis asks in a conversation you started.",
          );
        if (a.status !== "pending") throw new ActionError("conflict", "This was already decided.");
        const { target, says } = a.alwaysAllow;
        return writeRule(ctx.tx, { action: a.action, target, note: says }, ctx.now);
      },
    }),
    defineAction({
      name: "standing_rule.delete",
      description: "Remove a standing rule, so Jarvis asks again.",
      input: z.object({ id }),
      risk: "internal",
      callers: ["owner"],
      async handler(i, ctx) {
        const rows = await ctx.tx
          .delete(standingRule)
          .where(eq(standingRule.id, i.id))
          .returning({ id: standingRule.id });
        return { deleted: rows.length };
      },
    }),
  ],
  reflexes: [
    {
      name: "approvals.resume_jarvis",
      description:
        "After you approve or deny something Jarvis asked for, it picks up where it left off.",
      mode: "reactive",
      on: ["approval.resolved"],
      run(event) {
        const p = event.payload as {
          approvalId: string;
          action: string;
          decision: string;
          requestedBy: string;
          conversationId: string | null;
          result?: unknown;
          error?: string;
        };
        // One that ran out isn't worth a turn: Jarvis hears of it when it's next asked (D58).
        if (p.requestedBy !== "jarvis" || p.decision === "expired") return [];
        // A result or error from an untrusted turn's request, or from a page, may hold its words.
        const outside = (text: string) =>
          event.origin === "untrusted" ? asUntrusted(text, p.action) : text;
        const outcome =
          p.decision === "denied"
            ? "The owner said no. Don't retry it; adjust or ask what they'd prefer if it matters."
            : p.error
              ? `It was approved but failed: ${outside(p.error)}`
              : `It was approved and done. Result: ${outside(JSON.stringify(p.result ?? null).slice(0, 2000))}`;
        return [
          {
            kind: "turn",
            trigger: "approval",
            lane: "fast",
            conversationId: p.conversationId,
            dedupeKey: `approval:${p.approvalId}`,
            prompt: `Your request "${p.action}" (approval ${p.approvalId}) was decided. ${outcome}\nContinue the work if anything is left; otherwise reply briefly or not at all.`,
          },
        ];
      },
    },
  ],
  async digest(ctx): Promise<DigestItem[]> {
    const rows = await ctx.db
      .select()
      .from(approval)
      .where(eq(approval.status, "pending"))
      .orderBy(asc(approval.createdAt));
    // A request made after reading outside content, or by an outside agent, words it from there.
    return rows.map((r) => ({
      bucket: "needs_yes",
      text: r.summary,
      outside: r.origin === "untrusted" || writtenOutside(r.requestedBy),
    }));
  },
});
