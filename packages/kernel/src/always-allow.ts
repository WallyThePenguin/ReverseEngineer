// "Always allow" on an approval card (D70): a yes that also writes a standing rule as narrow as the
// card, the action and its one place or person. Only for what Jarvis asked in a conversation you
// started, never for email. The rule is written in the same transaction as the yes it came with,
// so a yes that's refused, runs out or fails leaves no rule behind.
import { PRINCIPAL } from "@hearth/core";
import { type AlwaysAllow, approval, type DbOrTx, standingRule, type Tx } from "@hearth/db";
import { and, eq } from "drizzle-orm";
import { writeAudit } from "./audit.ts";
import { newId } from "./ids.ts";
import type { ActionDef, Caller } from "./types.ts";

/** Never from a card's Always allow: email waits for your yes, card after card (D70). */
export const NEVER_ALWAYS = ["mail.send"];

export const NOT_ALWAYS =
  "Always allow is only for what Pip asks in a conversation you started, so nothing was done.";

/** What an Always allow for this call would cover, if its action offers one (D70). */
export const alwaysAllowOf = (def: ActionDef, input: unknown): AlwaysAllow | null =>
  def.alwaysAllow?.(input as never) ?? null;

/** The rule a card's Always allow would write, or null where the card can't offer one. */
export function alwaysAllowRule(a: typeof approval.$inferSelect): AlwaysAllow | null {
  if (a.origin !== "owner" || a.requestedBy !== PRINCIPAL.jarvis) return null;
  return NEVER_ALWAYS.includes(a.action) ? null : a.alwaysAllow;
}

type RuleRow = typeof standingRule.$inferSelect;

/** Writes Jarvis's rule for an action, or for its one place or person, and returns it. */
export async function writeStandingRule(
  tx: Tx,
  rule: { action: string; target: string | null; note: string },
  at: Date,
): Promise<RuleRow> {
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

/** An Always allow as it's pressed: the card, and who pressed it when. */
export interface Grant {
  row: typeof approval.$inferSelect;
  caller: Caller;
  correlationId: string;
  at: Date;
}

/** Kept either way: who gave Jarvis a standing yes, when, and from which card, or was refused one. */
export const auditAlwaysAllow = (db: DbOrTx, g: Grant, refused?: string) =>
  writeAudit(db, {
    def: { name: "standing_rule.always_allow", risk: "internal" },
    caller: g.caller,
    input: {
      approvalId: g.row.id,
      action: g.row.action,
      target: g.row.alwaysAllow?.target ?? null,
    },
    outcome: refused ? "denied" : "ok",
    error: refused ?? null,
    durationMs: 0,
    correlationId: g.correlationId,
    approvalId: g.row.id,
    at: g.at,
  });

/** What a yes with Always allow answers: its rule as Settings shows it, and whether an earlier
 * press had saved it. */
const keptRule = (r: RuleRow, already = false) => ({
  rule: { action: r.action, target: r.target, note: r.note },
  ...(already ? { already: true } : {}),
});

/** Writes the card's rule in its yes's transaction, with its audit row; returns what you're told. */
export async function keepAlwaysAllow(tx: Tx, g: Grant, rule: AlwaysAllow) {
  const row = { action: g.row.action, target: rule.target, note: rule.says };
  const written = await writeStandingRule(tx, row, g.at);
  await auditAlwaysAllow(tx, g);
  return keptRule(written);
}

/** Your first press went through, but its answer never reached you: its rule, if it's there. */
export async function alreadyKept(db: DbOrTx, approvalId: string, action: string, target: string) {
  const [a] = await db
    .select({ status: approval.status })
    .from(approval)
    .where(eq(approval.id, approvalId));
  if (a?.status !== "executed") return null;
  const [r] = await db
    .select()
    .from(standingRule)
    .where(
      and(
        eq(standingRule.action, action),
        eq(standingRule.principal, PRINCIPAL.jarvis),
        eq(standingRule.target, target),
      ),
    );
  return r ? keptRule(r, true) : null;
}
