// Mail sync: every minute or so, each account sends its queued changes to the provider, then
// brings in what changed there. Each account syncs on its own, under a lock, so the server's
// sync after sign-in and the worker's can't overlap; a backlog comes in batches, `more` says to
// call again at once, and a slowdown Gmail asks for pauses the account instead of failing (D55).
import { googleAccount, mailAccount, mailQuarantine } from "@hearth/db";
import { type ActionContext, savepoint } from "@hearth/kernel";
import { and, arrayContains, count, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { GOOGLE_SERVICE, type GoogleClient, SCOPES } from "../google/client.ts";
import { GmailProvider } from "../google/gmail-api.ts";
import { pushFlags } from "./flags.ts";
import type { MailProvider } from "./provider.ts";
import type { AccountRow } from "./store.ts";
import { type AccountOutcome, recordOutcome } from "./sync-state.ts";
import { bringIn, QUARANTINE_AFTER, readCursor, type Work } from "./sync-work.ts";

export interface MailSyncResult {
  accounts: number;
  added: number;
  removed: number;
  /** Call again at once: there's more to bring in. */
  more: boolean;
  failed: string[];
  /** Accounts Gmail asked to slow down. */
  paused: string[];
  /** Accounts another sync was already working on. */
  skipped: string[];
  /** When it's worth calling again, if the budget or a pause holds things up. */
  retryAt: string | null;
  /** A failure that may pass if tried again in a moment. */
  transient: boolean;
}

export const accountId = (provider: string, address: string) => `${provider}:${address}`;

/** Two-key advisory lock namespace for mail sync ("mail"). */
const LOCK = 0x6d61696c;

export function providerFor(ctx: ActionContext, account: AccountRow): MailProvider {
  if (account.provider === "gmail")
    return new GmailProvider(ctx.service<GoogleClient>(GOOGLE_SERVICE), ctx.tx);
  throw new Error(`No mail provider called ${account.provider}`);
}

/** Every Google account you connected Gmail for gets a mail account. */
async function gmailAccounts(ctx: ActionContext): Promise<AccountRow[]> {
  const google = await ctx.tx
    .select({ email: googleAccount.email })
    .from(googleAccount)
    .where(
      and(
        ne(googleAccount.status, "revoked"),
        arrayContains(googleAccount.scopes, [SCOPES.gmail[0]]),
      ),
    );
  for (const g of google)
    await ctx.tx
      .insert(mailAccount)
      .values({ id: accountId("gmail", g.email), provider: "gmail", address: g.email })
      .onConflictDoNothing();
  if (google.length === 0) return [];
  return ctx.tx
    .select()
    .from(mailAccount)
    .where(
      inArray(
        mailAccount.id,
        google.map((g) => accountId("gmail", g.email)),
      ),
    );
}

/**
 * One account: send queued changes, then bring in new mail, flag changes and deletions. Skips if
 * another sync holds the account, or while Gmail's pause lasts.
 */
export async function syncAccount(
  ctx: ActionContext,
  provider: MailProvider,
  account: AccountRow,
): Promise<AccountOutcome> {
  const none = { added: 0, removed: 0, more: false };
  const res = await ctx.tx.execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(${LOCK}, hashtext(${account.id})) AS locked`,
  );
  if (!res.rows[0]?.locked) return { status: "skipped", ...none };
  // Read again under the lock: a sync that just finished may have moved the cursor.
  const [fresh] = await ctx.tx.select().from(mailAccount).where(eq(mailAccount.id, account.id));
  if (!fresh) return { status: "skipped", ...none };
  if (fresh.pausedUntil && fresh.pausedUntil > ctx.now)
    return { status: "paused", ...none, more: true, retryAt: fresh.pausedUntil };
  let work: Work;
  try {
    work = await savepoint(ctx, async (sp) => {
      const pushed = await pushFlags(sp, provider, fresh);
      // A slowdown (or anything else) while sending changes: stop there, and read nothing.
      if (pushed.stopped)
        return { ...none, progressed: pushed.pushed > 0, stopped: pushed.stopped };
      return bringIn(sp, provider, fresh);
    });
  } catch (err) {
    // Something broke in Hearth itself; its writes are undone, and it counts as a failure.
    work = { ...none, progressed: false, stopped: err };
  }
  return recordOutcome(ctx, fresh, work);
}

/** Syncs every account, or only `address`. One failing doesn't stop the rest. */
export async function syncMail(ctx: ActionContext, address?: string): Promise<MailSyncResult> {
  const all = await gmailAccounts(ctx);
  const accounts = address ? all.filter((a) => a.address === address.toLowerCase()) : all;
  const result: MailSyncResult = {
    accounts: accounts.length,
    added: 0,
    removed: 0,
    more: false,
    failed: [],
    paused: [],
    skipped: [],
    retryAt: null,
    transient: false,
  };
  for (const account of accounts) {
    const r = await syncAccount(ctx, providerFor(ctx, account), account);
    result.added += r.added;
    result.removed += r.removed;
    if (r.status === "skipped") result.skipped.push(account.address);
    else result.more ||= r.more;
    if (r.status === "paused") result.paused.push(account.address);
    if (r.status === "failed") result.failed.push(`${account.address}: ${r.error}`);
    result.transient ||= Boolean(r.transient);
    if (r.retryAt && (!result.retryAt || r.retryAt.toISOString() < result.retryAt))
      result.retryAt = r.retryAt.toISOString();
  }
  return result;
}

/** How far along an account is, for Settings and the Mail page. */
export async function syncProgress(ctx: Pick<ActionContext, "tx">, account: AccountRow) {
  const c = readCursor(account.cursor ?? null);
  const [set] = await ctx.tx
    .select({ n: count() })
    .from(mailQuarantine)
    .where(
      and(eq(mailQuarantine.accountId, account.id), gte(mailQuarantine.attempts, QUARANTINE_AFTER)),
    );
  const [google] =
    account.provider === "gmail"
      ? await ctx.tx
          .select({ status: googleAccount.status })
          .from(googleAccount)
          .where(eq(googleAccount.email, account.address))
      : [];
  return {
    /** Google wants the account connected again before mail can sync. */
    reconnect: account.provider === "gmail" && (google?.status ?? "revoked") !== "ok",
    firstSyncDone: account.cursor !== null && !c.backfill && !("pageToken" in c.provider),
    backfill: c.backfill
      ? { fetched: Math.max(0, c.backfill.listed - c.pending.length), target: c.backfill.target }
      : null,
    waiting: c.pending.length + c.relabel.length,
    setAside: set?.n ?? 0,
  };
}
