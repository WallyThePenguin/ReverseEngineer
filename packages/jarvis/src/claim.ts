// Which queued turn runs next. Yours come first: your reactive turns, then Slack members' turns,
// then Jarvis's own proactive work. Only one member turn runs at a time, so however many people
// write to Jarvis in Slack, a runner is always free for you (D62). One turn at a time per
// conversation or record, so the same thing is never answered twice at once.
import { jarvisTurn } from "@hearth/db";
import type { Kernel } from "@hearth/kernel";
import { and, asc, desc, eq, lte, sql } from "drizzle-orm";

export type TurnRow = typeof jarvisTurn.$inferSelect;

/** Claims the next runnable turn, marked running (committed) before it's returned. */
export function claimNextTurn(kernel: Kernel, now: Date): Promise<TurnRow | null> {
  return kernel.db.transaction(async (tx) => {
    // Claims take turns: otherwise two workers could each see "nothing running" for the same
    // conversation before either commits, and answer it twice at once.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('jarvis_claim'))`);
    const member = sql`${jarvisTurn.trigger} = 'slack_member'`;
    const [next] = await tx
      .select()
      .from(jarvisTurn)
      .where(
        and(
          eq(jarvisTurn.status, "queued"),
          lte(jarvisTurn.notBefore, now),
          sql`NOT EXISTS (SELECT 1 FROM jarvis_turn r WHERE r.status = 'running'
            AND ((r.conversation_id IS NOT NULL AND r.conversation_id = ${jarvisTurn.conversationId})
              OR (r.subject_id IS NOT NULL AND r.subject_id = ${jarvisTurn.subjectId})))`,
          sql`(NOT ${member} OR NOT EXISTS (SELECT 1 FROM jarvis_turn m
            WHERE m.status = 'running' AND m.trigger = 'slack_member'))`,
        ),
      )
      .orderBy(
        desc(sql`${jarvisTurn.mode} = 'reactive' AND NOT ${member}`),
        desc(member),
        asc(jarvisTurn.queuedAt),
      )
      .limit(1)
      .for("update", { skipLocked: true });
    if (!next) return null;
    const [claimed] = await tx
      .update(jarvisTurn)
      .set({ status: "running", startedAt: now, attempts: sql`${jarvisTurn.attempts} + 1` })
      .where(eq(jarvisTurn.id, next.id))
      .returning();
    return claimed ?? null;
  });
}
