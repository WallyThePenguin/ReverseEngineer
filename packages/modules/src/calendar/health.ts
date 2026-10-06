// How each Google account's calendars are syncing, saved after each round the way Slack, GitHub
// and Notion save theirs (D61). One that won't pass by itself (a calendar Google says isn't there,
// or won't show Hearth) is told at once; others after 3 rounds in a row and half an hour with
// nothing read, and Google signing Hearth out at once, with how to connect again. Each run of
// failures is told once, and the first good round closes the notice. A slowdown Google asks for
// isn't a failure.
import { calendar, googleAccount } from "@hearth/db";
import type { ActionContext } from "@hearth/kernel";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { closeAlerts, nextHealth, type Trouble, worst } from "../connector-health.ts";
import { GoogleApiError } from "../google/errors.ts";

type Account = typeof googleAccount.$inferSelect;

/** What a failed calendar call means for its account's health. */
export function troubleOf(err: unknown, what: string): Trouble {
  const message = `${what}: ${err instanceof Error ? err.message : String(err)}`;
  if (err instanceof GoogleApiError) {
    // Signed out: nothing syncs until you connect the account again, so you're told at once.
    if (err.kind === "auth") return { kind: "revoked", message };
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
 * Saves how an account's round went, and tells or closes its notice. `paused`: Google asked
 * Hearth to wait partway, so what wasn't read isn't a failure, and a run of failures goes on.
 */
export async function recordCalendarHealth(
  ctx: ActionContext,
  acct: Account,
  troubles: Trouble[],
  progressed: boolean,
  paused: boolean,
) {
  const trouble = worst(troubles);
  const mine = eq(googleAccount.email, acct.email);
  // Only a slowdown this round: nothing to judge.
  if (!trouble && paused) {
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
