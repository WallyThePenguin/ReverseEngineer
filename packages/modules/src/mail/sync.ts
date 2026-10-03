// Mail sync: every minute or so, each account sends its queued changes to the provider, then
// brings in what changed there. A first sync comes in pages; `more` says to call again at once.
import { googleAccount, mailAccount, mailMessage } from "@hearth/db";
import type { ActionContext } from "@hearth/kernel";
import { and, arrayContains, eq, inArray, ne } from "drizzle-orm";
import { GOOGLE_SERVICE, type GoogleClient, SCOPES } from "../google/client.ts";
import { GmailProvider } from "../google/gmail-api.ts";
import { pushFlags, setFlags } from "./flags.ts";
import type { MailProvider } from "./provider.ts";
import { type AccountRow, removeMail, saveMail } from "./store.ts";

export interface MailSyncResult {
  accounts: number;
  added: number;
  removed: number;
  more: boolean;
  failed: string[];
}

export const accountId = (provider: string, address: string) => `${provider}:${address}`;

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

/** One account: send queued changes, then bring in new mail, flag changes and deletions. */
export async function syncAccount(
  ctx: ActionContext,
  provider: MailProvider,
  account: AccountRow,
): Promise<{ added: number; removed: number; more: boolean }> {
  await pushFlags(ctx, provider, account);
  const changes = await provider.changes(account.address, account.cursor ?? null);
  // New mail is announced (so Jarvis can look at it) only once the first sync is done.
  const settled =
    account.cursor !== null && !("pageToken" in (account.cursor ?? {})) && !changes.restarted;
  let removed = await removeMail(ctx, account.id, changes.removed);
  const known = changes.changed.length
    ? await ctx.tx
        .select()
        .from(mailMessage)
        .where(
          and(
            eq(mailMessage.accountId, account.id),
            inArray(mailMessage.providerId, changes.changed),
          ),
        )
    : [];
  const fresh = changes.changed.filter((id) => !known.some((k) => k.providerId === id));
  let added = 0;
  for (const raw of await provider.fetch(account.address, fresh)) {
    const saved = await saveMail(ctx, account, raw);
    if (!saved?.added) continue;
    added++;
    if (settled && !saved.outbound)
      ctx.emit({
        kind: "mail.received",
        entityId: saved.id,
        payload: {
          threadId: saved.threadId,
          from: saved.parsed?.from?.address ?? "",
          subject: saved.parsed?.subject ?? "",
        },
      });
  }
  if (known.length) {
    const labels = await provider.labels(
      account.address,
      known.map((k) => k.providerId),
    );
    const gone = known.filter((k) => !labels.has(k.providerId)).map((k) => k.providerId);
    removed += await removeMail(ctx, account.id, gone);
    await setFlags(
      ctx,
      known.filter((k) => labels.has(k.providerId)),
      labels,
    );
  }
  await ctx.tx
    .update(mailAccount)
    .set({ cursor: changes.cursor, syncedAt: ctx.now, lastError: null })
    .where(eq(mailAccount.id, account.id));
  return { added, removed, more: changes.more };
}

/** Syncs every account. One failing doesn't stop the rest. */
export async function syncMail(ctx: ActionContext): Promise<MailSyncResult> {
  const accounts = await gmailAccounts(ctx);
  const result: MailSyncResult = {
    accounts: accounts.length,
    added: 0,
    removed: 0,
    more: false,
    failed: [],
  };
  for (const account of accounts) {
    try {
      const r = await syncAccount(ctx, providerFor(ctx, account), account);
      result.added += r.added;
      result.removed += r.removed;
      result.more ||= r.more;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.failed.push(`${account.address}: ${message}`);
      await ctx.tx
        .update(mailAccount)
        .set({ lastError: message })
        .where(eq(mailAccount.id, account.id));
    }
  }
  if (result.failed.length)
    ctx.emit({ kind: "mail.sync_failed", payload: { errors: result.failed } });
  return result;
}
