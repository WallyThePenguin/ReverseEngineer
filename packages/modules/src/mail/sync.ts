// Mail sync: every minute or so, each account sends its queued changes to the provider, then
// brings in what changed there. Each account syncs on its own, under a lock, so the server's
// sync after sign-in and the worker's can't overlap; a backlog comes in batches, `more` says to
// call again at once, and a slowdown Gmail asks for pauses the account instead of failing (D55).
import { googleAccount, mailAccount, mailQuarantine } from "@hearth/db";
import { type ActionContext, ActionError, savepoint } from "@hearth/kernel";
import { and, arrayContains, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { SCOPES } from "../google/client.ts";
import { pushFlags } from "./flags.ts";
import type { MailProvider } from "./provider.ts";
import { providerFor } from "./providers.ts";
import { repairSome } from "./repair.ts";
import type { AccountRow } from "./store.ts";
import { QUARANTINE_AFTER, release } from "./sync-aside.ts";
import { readCursor, writeCursor } from "./sync-cursor.ts";
import { type AccountOutcome, recordOutcome } from "./sync-state.ts";
import { bringIn, type Work } from "./sync-work.ts";

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

/**
 * Waits for any sync of these accounts that's running to finish, then keeps them from syncing
 * until the transaction ends (a sync skips an account it can't lock). In one order, so two of
 * these can't wait on each other.
 */
export async function holdSyncs(ctx: Pick<ActionContext, "tx">, accountIds: string[]) {
  for (const id of [...accountIds].sort())
    await ctx.tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK}, hashtext(${id}))`);
}

export { providerFor };

/**
 * Every Google account you connected Gmail for gets a mail account. Read so that one being
 * disconnected is waited for (google.disconnect holds it), then left out: it mustn't come back.
 */
async function gmailAccounts(ctx: ActionContext): Promise<AccountRow[]> {
  const google = await ctx.tx
    .select({ email: googleAccount.email })
    .from(googleAccount)
    .where(
      and(
        ne(googleAccount.status, "revoked"),
        arrayContains(googleAccount.scopes, [SCOPES.gmail[0]]),
      ),
    )
    .for("key share");
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
  const outcome = await recordOutcome(ctx, fresh, work);
  // A quiet round looks for originals missing from this PC (6.6). It never holds up mail.
  if (outcome.status === "ok" && !outcome.more)
    await savepoint(ctx, (sp) => repairSome(sp, provider, fresh)).catch(() => 0);
  return outcome;
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
  const aside = await ctx.tx
    .select({ id: mailQuarantine.providerId })
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
    waiting: c.pending.length + c.relabel.length + Object.keys(c.parked).length,
    // What's been put back to try again is waiting, no longer set aside.
    setAside: aside.filter((q) => !(q.id in c.parked)).length,
  };
}

/**
 * Puts an account's set-aside mail back, to be tried again by the next sync (Settings → Google's
 * "Try again"). Waits for a sync of the account to finish first, so neither undoes the other.
 */
export async function retrySetAside(ctx: ActionContext, address: string): Promise<number> {
  const [account] = await ctx.tx
    .select({ id: mailAccount.id })
    .from(mailAccount)
    .where(eq(mailAccount.address, address.toLowerCase()));
  if (!account) throw new ActionError("not_found", `No mail account ${address}`);
  await ctx.tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK}, hashtext(${account.id}))`);
  const [fresh] = await ctx.tx.select().from(mailAccount).where(eq(mailAccount.id, account.id));
  const c = readCursor(fresh?.cursor ?? null);
  const back = await release(ctx, account.id, c, true);
  if (back)
    await ctx.tx
      .update(mailAccount)
      .set({ cursor: writeCursor(c) })
      .where(eq(mailAccount.id, account.id));
  return back;
}
