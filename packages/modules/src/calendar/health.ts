// How each Google account's calendars are syncing, saved after each round the way Slack, GitHub
// and Notion save theirs (D61). One that won't pass by itself (a calendar Google won't show Hearth,
// or says isn't there when the account has no other calendar selected) is told at once;
// others after 3 rounds in a row and half an hour of them with nothing read, and Google signing
// Hearth out at once, with how to connect again. Each account's
// run of failures is told once, and its first good round closes its notice (keyed by account,
// connector-health.ts). A slowdown Google asks for isn't a failure.
import { googleAccount } from "@hearth/db";
import type { ActionContext } from "@hearth/kernel";
import { eq } from "drizzle-orm";
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

/** Closes the account's open calendar notices: it syncs again, or it's gone. */
export const closeCalendarAlerts = (ctx: ActionContext, account: string) =>
  closeAlerts(ctx, "calendar", account);

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
  const tried = { calendarAttemptedAt: ctx.now };
  // Only a slowdown this round: nothing to judge.
  if (!trouble && paused) {
    await ctx.tx
      .update(googleAccount)
      .set(progressed ? { ...tried, calendarSyncedAt: ctx.now } : tried)
      .where(mine);
    return;
  }
  const next = nextHealth(
    {
      syncState: acct.calendarState,
      failures: acct.calendarFailures,
      failingSince: acct.calendarFailingSince,
      syncedAt: acct.calendarSyncedAt,
      attemptedAt: acct.calendarAttemptedAt,
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
      ...tried,
      ...(v.syncedAt ? { calendarSyncedAt: v.syncedAt } : {}),
    })
    .where(mine);
  if (next.recovered) await closeCalendarAlerts(ctx, acct.email);
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
