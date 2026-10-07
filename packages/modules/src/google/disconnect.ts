// Removing a Google account (Settings > Google > Disconnect): its tokens, calendars and mail leave
// Hearth, and so do its open "isn't syncing" notices and the raw copies of its mail that nothing
// else needs. Its unsent drafts can stay, if you say so: they wait in Mail, from no account,
// until you pick another to send them from (6.9).
import {
  calendar,
  entity,
  googleAccount,
  mailAccount,
  mailDraft,
  mailMessage,
  mailOp,
  mailThread,
} from "@hearth/db";
import { type ActionContext, defineAction } from "@hearth/kernel";
import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { dropCalendars, handOver } from "../calendar/calendars.ts";
import { closeCalendarAlerts } from "../calendar/health.ts";
import { BLOB_SERVICE, type BlobStore } from "../mail/blobs.ts";
import { recomputeThread } from "../mail/flags.ts";
import { closeMailAlerts } from "../mail/sync-state.ts";
import { GOOGLE_SERVICE, type GoogleClient } from "./client.ts";

/** Deletes a record kind's rows for the account, with their entities. */
async function dropMail(
  ctx: ActionContext,
  table: typeof mailMessage | typeof mailThread | typeof mailDraft,
  accountId: string,
) {
  await ctx.tx
    .delete(entity)
    .where(
      inArray(
        entity.id,
        ctx.tx.select({ id: table.entityId }).from(table).where(eq(table.accountId, accountId)),
      ),
    );
}

/**
 * The leaving account's conversations that hold another account's mail (a copy of an email sent
 * to both, or a reply that came only there) stay, as that account's; only the leaving account's
 * own messages go. Where that account has the conversation already, its mail joins it there.
 * Returns the conversations kept, to work out again once the leaving mail is gone.
 */
async function rehome(ctx: ActionContext, leaving: string): Promise<string[]> {
  const shared = await ctx.tx
    .selectDistinct({
      id: mailThread.entityId,
      root: mailThread.rootMessageId,
      owner: mailMessage.accountId,
    })
    .from(mailMessage)
    .innerJoin(mailThread, eq(mailThread.entityId, mailMessage.threadId))
    .where(and(eq(mailThread.accountId, leaving), ne(mailMessage.accountId, leaving)));
  const done = new Set<string>();
  const kept = new Set<string>();
  for (const t of shared) {
    if (done.has(t.id)) continue;
    done.add(t.id);
    const [there] = await ctx.tx
      .select({ id: mailThread.entityId })
      .from(mailThread)
      .where(and(eq(mailThread.accountId, t.owner), eq(mailThread.rootMessageId, t.root)));
    if (!there) {
      await ctx.tx
        .update(mailThread)
        .set({ accountId: t.owner })
        .where(eq(mailThread.entityId, t.id));
      kept.add(t.id);
      continue;
    }
    const moved = [
      ...(await ctx.tx
        .update(mailMessage)
        .set({ threadId: there.id })
        .where(and(eq(mailMessage.threadId, t.id), ne(mailMessage.accountId, leaving)))
        .returning({ id: mailMessage.entityId })),
      ...(await ctx.tx
        .update(mailDraft)
        .set({ threadId: there.id })
        .where(eq(mailDraft.threadId, t.id))
        .returning({ id: mailDraft.entityId })),
    ];
    if (moved.length)
      await ctx.tx
        .update(entity)
        .set({ parentId: there.id })
        .where(
          and(
            eq(entity.parentId, t.id),
            inArray(
              entity.id,
              moved.map((m) => m.id),
            ),
          ),
        );
    await ctx.tx
      .update(mailOp)
      .set({ threadId: there.id })
      .where(and(eq(mailOp.threadId, t.id), ne(mailOp.accountId, leaving)));
    kept.add(there.id);
  }
  return [...kept];
}

export const disconnectAction = defineAction({
  name: "google.disconnect",
  description:
    "Forget a Google account: its tokens, calendars and mail leave Hearth. keepDrafts keeps its unsent drafts, to send from another account.",
  input: z.object({ email: z.string().email(), keepDrafts: z.boolean().default(false) }),
  risk: "internal",
  callers: ["owner"],
  async handler(i, ctx) {
    const email = i.email.toLowerCase();
    const cals = await ctx.tx.select().from(calendar).where(eq(calendar.account, email));
    await handOver(ctx, cals);
    await dropCalendars(
      ctx,
      cals.map((c) => c.id),
    );
    const mailId = `gmail:${email}`;
    const files = await ctx.tx
      .selectDistinct({ hash: mailMessage.rawHash })
      .from(mailMessage)
      .where(eq(mailMessage.accountId, mailId));
    const kept = i.keepDrafts
      ? await ctx.tx
          .select({ id: mailDraft.entityId })
          .from(mailDraft)
          .where(eq(mailDraft.accountId, mailId))
      : [];
    const shared = await rehome(ctx, mailId);
    await dropMail(ctx, mailMessage, mailId);
    await ctx.tx.delete(mailOp).where(eq(mailOp.accountId, mailId));
    await dropMail(ctx, mailThread, mailId);
    for (const id of shared) await recomputeThread(ctx, id);
    // Kept drafts lose their account with it (the key is set to null) and wait for a new From.
    if (!i.keepDrafts) await dropMail(ctx, mailDraft, mailId);
    await closeMailAlerts(ctx, mailId, false);
    await ctx.tx.delete(mailAccount).where(eq(mailAccount.id, mailId));
    const gone = await ctx.tx
      .delete(googleAccount)
      .where(eq(googleAccount.email, email))
      .returning({ email: googleAccount.email, token: googleAccount.refreshToken });
    await closeCalendarAlerts(ctx, email);
    let google: GoogleClient | null = null;
    try {
      google = ctx.service<GoogleClient>(GOOGLE_SERVICE);
    } catch {}
    for (const g of gone) await google?.revoke(g.token, g.email);
    await forgetFiles(
      ctx,
      files.map((f) => f.hash),
    );
    return { removed: gone.length, keptDrafts: kept.length };
  },
});

/**
 * Deletes the raw copies of the account's mail, but not ones another account's mail has too. In
 * the background: an account can have a hundred thousand of them. Should one go that's needed
 * after all (the same message arriving in another account just now), it's fetched again (6.6).
 */
async function forgetFiles(ctx: ActionContext, hashes: string[]) {
  if (hashes.length === 0) return;
  let blobs: BlobStore;
  try {
    blobs = ctx.service<BlobStore>(BLOB_SERVICE);
  } catch {
    return;
  }
  const still = new Set<string>();
  for (let i = 0; i < hashes.length; i += 5000) {
    const rows = await ctx.tx
      .selectDistinct({ hash: mailMessage.rawHash })
      .from(mailMessage)
      .where(inArray(mailMessage.rawHash, hashes.slice(i, i + 5000)));
    for (const r of rows) still.add(r.hash);
  }
  void blobs.remove(hashes.filter((h) => !still.has(h))).catch(() => 0);
}
