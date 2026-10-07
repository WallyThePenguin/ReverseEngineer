// How a mail account's sync is going, written after each sync (D55). A slowdown Gmail asks for
// is not a failure: it pauses the account quietly. Failures alert only when they're permanent
// (access to reconnect) or keep happening (3 in a row and nothing synced for 30 minutes), and
// the first good sync after that closes the alert again.
import { type MailSyncState, mailAccount, notification } from "@hearth/db";
import { type ActionContext, ActionError } from "@hearth/kernel";
import { and, eq, ne, or, sql } from "drizzle-orm";
import { MIN_PAUSE_MS } from "../google/budget.ts";
import { MailProviderError } from "./provider.ts";
import type { AccountRow } from "./store.ts";
import type { Work } from "./sync-work.ts";

/** Failures in a row before an alert, if nothing synced for FAILING_AFTER_MS either. */
export const FAILURES_BEFORE_ALERT = 3;
export const FAILING_AFTER_MS = 30 * 60_000;
/** No try for this long: the PC slept or Hearth was off, so failures from before don't count. */
export const AWAY_MS = 15 * 60_000;

export interface RunState {
  syncState: string;
  failures: number;
  failingSince: Date | null;
  syncedAt: Date | null;
  /** When it last tried. Left out by a sync that doesn't keep it: no gap is ever seen. */
  attemptedAt?: Date | null;
}

/**
 * Where a failure leaves its run of failures. "Nothing synced" counts from when the run started,
 * not from the last sync, which after a night asleep was hours ago; and the first failure after a
 * gap with no tries starts a new run. So the first syncs after the PC wakes, quick retries
 * included, never make it failing. A run already told goes on, so its notice stays the one open.
 */
export function runOfFailures(h: RunState, now: Date) {
  const told = h.syncState === "failing" || h.syncState === "revoked";
  const away =
    !told &&
    h.attemptedAt !== undefined &&
    now.getTime() - (h.attemptedAt?.getTime() ?? 0) >= AWAY_MS;
  const failures = away ? 1 : h.failures + 1;
  const since = away ? now : (h.failingSince ?? now);
  const quietFor = now.getTime() - Math.max(h.syncedAt?.getTime() ?? 0, since.getTime());
  return { failures, since, quietFor };
}
/** Alerts from before D55 were keyed by day: "mail.sync_failed:2026-10-04". */
const OLD_ALERT = "^mail\\.sync_failed:[0-9-]+$";

export interface AccountOutcome {
  status: "ok" | "skipped" | "paused" | "paced" | "failed";
  added: number;
  removed: number;
  more: boolean;
  /** When trying again is worthwhile (paused or paced). */
  retryAt?: Date;
  error?: string;
  /** A failure that may pass if tried again in a moment (the network, a server error). */
  transient?: boolean;
}

/** The dedupe key of an account's alert for one run of failures. */
export const alertKey = (accountId: string, since: Date | string) =>
  `mail.sync_failed:${accountId}:${new Date(since).toISOString()}`;

type Kind = "slow_down" | "paced" | "auth" | "transient" | "refused";

function kindOf(err: unknown): Kind {
  if (err instanceof MailProviderError) return err.kind === "gone" ? "refused" : err.kind;
  // Hearth's own refusals (Google isn't set up, the account is gone) won't pass by themselves.
  if (err instanceof ActionError) return "refused";
  return "transient";
}

/**
 * Marks the account's open "Mail isn't syncing" alerts done: it syncs again, or it's gone.
 * `legacy`: the day-keyed ones from before D55 too, which didn't say which account.
 */
export async function closeMailAlerts(ctx: ActionContext, accountId: string, legacy = true) {
  const rows = await ctx.tx
    .update(notification)
    .set({ state: "done", updatedAt: ctx.now })
    .where(
      and(
        ne(notification.state, "done"),
        or(
          sql`starts_with(${notification.dedupeKey}, ${`mail.sync_failed:${accountId}:`})`,
          legacy ? sql`${notification.dedupeKey} ~ ${OLD_ALERT}` : undefined,
        ),
      ),
    )
    .returning({ id: notification.id, entityId: notification.entityId });
  for (const r of rows)
    ctx.emit({
      kind: "notification.updated",
      entityId: r.entityId,
      payload: { notificationId: r.id, state: "done" },
    });
}

/** Saves how the sync went on the account, and raises or closes its alert. */
export async function recordOutcome(
  ctx: ActionContext,
  account: AccountRow,
  work: Work,
): Promise<AccountOutcome> {
  const base = { added: work.added, removed: work.removed, more: work.more };
  const set = (values: Partial<typeof mailAccount.$inferInsert>) =>
    ctx.tx
      .update(mailAccount)
      .set({ ...values, attemptedAt: ctx.now })
      .where(eq(mailAccount.id, account.id));
  const busy: MailSyncState = work.more ? "catching_up" : "ok";
  const succeeded = async (state: MailSyncState) => {
    await set({
      syncState: state,
      syncedAt: ctx.now,
      lastError: null,
      failures: 0,
      failingSince: null,
      pausedUntil: null,
    });
    if (account.failures > 0) await closeMailAlerts(ctx, account.id);
  };
  if (!work.stopped) {
    await succeeded(busy);
    return { status: "ok", ...base };
  }
  const err = work.stopped;
  const kind = kindOf(err);
  const wait = err instanceof MailProviderError ? (err.retryAfterMs ?? 0) : 0;
  if (kind === "paced") {
    // Hearth is pacing itself: the rest comes once the minute's budget allows.
    if (work.progressed) await succeeded("catching_up");
    else await set({ syncState: "catching_up" });
    return { status: "paced", ...base, more: true, retryAt: new Date(ctx.now.getTime() + wait) };
  }
  if (kind === "slow_down") {
    // Google's own slowdown already says a minute or more (client.ts); a pause another process
    // ran into first says what's left of it, and the account waits just that long.
    const until = new Date(ctx.now.getTime() + (wait > 0 ? wait : MIN_PAUSE_MS));
    if (work.progressed) await succeeded("paused");
    // In the middle of a run of failures it's still failing, paused as well, so its alert stays.
    const failing = !work.progressed && account.syncState === "failing";
    await set({ syncState: failing ? "failing" : "paused", pausedUntil: until });
    return { status: "paused", ...base, more: true, retryAt: until };
  }
  const message = err instanceof Error ? err.message : String(err);
  const { failures, since, quietFor } = runOfFailures(account, ctx.now);
  const failing =
    kind === "auth" ||
    kind === "refused" ||
    (failures >= FAILURES_BEFORE_ALERT && quietFor >= FAILING_AFTER_MS);
  const was = account.syncState;
  await set({
    failures,
    failingSince: since,
    lastError: message.slice(0, 1000),
    syncState: failing || was === "failing" ? "failing" : was === "paused" ? "catching_up" : was,
  });
  if (failing && was !== "failing")
    ctx.emit({
      kind: "mail.sync_failed",
      payload: {
        account: account.address,
        accountId: account.id,
        since: since.toISOString(),
        reconnect: kind === "auth",
        errors: [`${account.address}: ${message}`],
      },
    });
  return { status: "failed", ...base, error: message, transient: kind === "transient" };
}
