// "Always allow" on an approval card (D70): a yes that also writes a standing rule as narrow as the
// card, the action and its one place or person. Only for what Jarvis asked in a conversation you
// started, never for email. The rule is written in the same transaction as the yes it came with,
// so a yes that's refused, runs out or fails leaves no rule behind.
import { PRINCIPAL } from "@hearth/core";
import { type AlwaysAllow, type approval, standingRule, type Tx } from "@hearth/db";
import { newId } from "./ids.ts";
import type { ActionDef } from "./types.ts";

/** Never from a card's Always allow: email waits for your yes, card after card (D70). */
export const NEVER_ALWAYS = ["mail.send"];

export const NOT_ALWAYS =
  "Always allow is only for what Jarvis asks in a conversation you started, so nothing was done.";

/** What an Always allow for this call would cover, if its action offers one (D70). */
export const alwaysAllowOf = (def: ActionDef, input: unknown): AlwaysAllow | null =>
  def.alwaysAllow?.(input as never) ?? null;

/** The rule a card's Always allow would write, or null where the card can't offer one. */
export function alwaysAllowRule(a: typeof approval.$inferSelect): AlwaysAllow | null {
  if (a.origin !== "owner" || a.requestedBy !== PRINCIPAL.jarvis) return null;
  return NEVER_ALWAYS.includes(a.action) ? null : a.alwaysAllow;
}

/** Writes Jarvis's rule for an action, or for its one place or person, and returns it. */
export async function writeStandingRule(
  tx: Tx,
  rule: { action: string; target: string | null; note: string },
  at: Date,
) {
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
