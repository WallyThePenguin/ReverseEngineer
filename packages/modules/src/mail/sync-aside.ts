// Mail that keeps failing is set aside, so it never holds up the rest (6.2). It isn't lost: it's
// tried again a day after it last failed, or at once when you ask in Settings → Google, and set
// aside again if it still fails.
import { mailQuarantine } from "@hearth/db";
import type { ActionContext } from "@hearth/kernel";
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import type { SyncCursor } from "./sync-cursor.ts";

/** A message that fails to save (or to download) this many times is set aside. */
export const QUARANTINE_AFTER = 3;
/** Set-aside mail is tried again this long after it last failed. */
export const RETRY_ASIDE_MS = 24 * 3600_000;
/** How often a sync looks for set-aside mail that's due another try. */
export const LOOK_ASIDE_MS = 3600_000;
/** Set-aside messages a sync takes back at once, at most (all of them when you ask). */
const DAILY_MAX = 20;

/**
 * Notes a message that failed to save or download. Returns how many times it has; a failure
 * within `spacingMs` of the last counted one is noted but not counted.
 */
export async function quarantine(
  ctx: ActionContext,
  accountId: string,
  providerId: string,
  err: unknown,
  spacingMs = 0,
) {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  const counts = sql`${mailQuarantine.lastFailedAt} <= ${new Date(ctx.now.getTime() - spacingMs)}`;
  const [row] = await ctx.tx
    .insert(mailQuarantine)
    .values({
      accountId,
      providerId,
      attempts: 1,
      lastError: message,
      firstFailedAt: ctx.now,
      lastFailedAt: ctx.now,
    })
    .onConflictDoUpdate({
      target: [mailQuarantine.accountId, mailQuarantine.providerId],
      set: {
        attempts: sql`CASE WHEN ${counts} THEN ${mailQuarantine.attempts} + 1 ELSE ${mailQuarantine.attempts} END`,
        lastError: message,
        lastFailedAt: sql`CASE WHEN ${counts} THEN ${ctx.now} ELSE ${mailQuarantine.lastFailedAt} END`,
      },
    })
    .returning({ attempts: mailQuarantine.attempts });
  return row?.attempts ?? 1;
}

/** A message that failed before came in after all: its failures are forgotten. */
export async function forget(ctx: ActionContext, accountId: string, providerId: string) {
  await ctx.tx
    .delete(mailQuarantine)
    .where(and(eq(mailQuarantine.accountId, accountId), eq(mailQuarantine.providerId, providerId)));
}

/**
 * Puts set-aside mail back beside the queue, to be tried after new mail: what's been aside a day
 * since it last failed, or all of it (`all`) when you ask. It comes back quietly, as old news, so
 * Jarvis doesn't take it for new mail. Returns how many came back.
 */
export async function release(
  ctx: Pick<ActionContext, "tx" | "now">,
  accountId: string,
  c: SyncCursor,
  all = false,
) {
  const rows = await ctx.tx
    .select({ id: mailQuarantine.providerId })
    .from(mailQuarantine)
    .where(
      and(
        eq(mailQuarantine.accountId, accountId),
        gte(mailQuarantine.attempts, QUARANTINE_AFTER),
        all
          ? undefined
          : lte(mailQuarantine.lastFailedAt, new Date(ctx.now.getTime() - RETRY_ASIDE_MS)),
      ),
    )
    .orderBy(asc(mailQuarantine.lastFailedAt))
    .limit(all ? 1000 : DAILY_MAX);
  const back = rows.filter((r) => !(r.id in c.parked));
  for (const r of back) c.parked[r.id] = { at: ctx.now.getTime(), quiet: true };
  return back.length;
}
