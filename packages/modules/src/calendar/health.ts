// How each Google account's calendars are syncing, saved after each round the way Slack, GitHub
// and Notion save theirs (D61). One that won't pass by itself (a calendar Google says isn't there,
// or won't show Hearth) is told at once; others after 3 rounds in a row and half an hour with
// nothing read. Each run of failures is told once, and the first good round closes the notice.
// A slowdown Google asks for isn't a failure, and Google turning down Hearth's access is told by
// the account itself (Settings > Google, and the Google sync's health), not again here.
import { calendar, googleAccount } from "@hearth/db";
import type { ActionContext } from "@hearth/kernel";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { closeAlerts, nextHealth, type Trouble, worst } from "../connector-health.ts";
import { GoogleApiError } from "../google/errors.ts";

type Account = typeof googleAccount.$inferSelect;

/** What a failed calendar call means for its account's health; null when it isn't Calendar's to tell. */
export function troubleOf(err: unknown, what: string): Trouble | null {
  const message = `${what}: ${err instanceof Error ? err.message : String(err)}`;
  if (err instanceof GoogleApiError) {
    if (err.kind === "auth") return null;
    if (err.kind === "refused" || err.kind === "not_found") return { kind: "refused", message };
  }
  return { kind: "transient", message };
}

/**
 * Calendar's notices close once nothing left is failing: no account's calendars, and no calendar
 * still synced, say they have a problem.
 */
export async function closeCalendarAlerts(ctx: ActionContext) {
  const [failing] = await ctx.tx
    .select({ id: calendar.id })
    .from(calendar)
    .where(and(eq(calendar.selected, true), isNotNull(calendar.lastError)))
    .limit(1);
  const [troubled] = await ctx.tx
    .select({ email: googleAccount.email })
    .from(googleAccount)
    .where(ne(googleAccount.calendarState, "ok"))
    .limit(1);
  if (!failing && !troubled) await closeAlerts(ctx, "calendar");
}

/**
 * Saves how an account's round went, and tells or closes its notice. `troubles` holds null for a
 * call Google turned down for the account's access (told elsewhere). `paused`: Google asked
 * Hearth to wait partway, so what wasn't read isn't a failure, and a run of failures goes on.
 */
export async function recordCalendarHealth(
  ctx: ActionContext,
  acct: Account,
  troubles: (Trouble | null)[],
  progressed: boolean,
  paused: boolean,
) {
  const trouble = worst(troubles.filter((t): t is Trouble => t !== null));
  const mine = eq(googleAccount.email, acct.email);
  // Only Google's own word this round (a slowdown, the account's access): nothing to judge.
  if (!trouble && (paused || troubles.length)) {
    if (progressed)
      await ctx.tx.update(googleAccount).set({ calendarSyncedAt: ctx.now }).where(mine);
    return;
  }
  const next = nextHealth(
    {
      syncState: acct.calendarState,
      failures: acct.calendarFailures,
      failingSince: acct.calendarFailingSince,
      syncedAt: acct.calendarSyncedAt,
    },
    ctx.now,
    trouble,
    progressed,
  );
  const v = next.values;
  await ctx.tx
    .update(googleAccount)
    .set({
      calendarState: v.syncState,
      calendarFailures: v.failures,
      calendarFailingSince: v.failingSince,
      calendarError: v.lastError,
      ...(v.syncedAt ? { calendarSyncedAt: v.syncedAt } : {}),
    })
    .where(mine);
  if (next.recovered) await closeCalendarAlerts(ctx);
  if (next.alert && trouble)
    ctx.emit({
      kind: "calendar.sync_failed",
      payload: {
        account: acct.email,
        errors: trouble.message.split("\n"),
        since: next.alert.since.toISOString(),
        reconnect: next.alert.reconnect,
      },
    });
}
