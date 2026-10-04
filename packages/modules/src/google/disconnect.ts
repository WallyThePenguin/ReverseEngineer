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
  mailThread,
  notification,
} from "@hearth/db";
import { type ActionContext, defineAction } from "@hearth/kernel";
import { and, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { dropCalendars, handOver } from "../calendar/calendars.ts";
import { BLOB_SERVICE, type BlobStore } from "../mail/blobs.ts";
import { closeMailAlerts } from "../mail/sync-state.ts";
import { GOOGLE_SERVICE, type GoogleClient } from "./client.ts";

/**
 * Calendar's notices aren't kept per account. They close once nothing left is failing: no
 * calendar still synced, and no account, says it has a problem.
 */
async function closeCalendarAlerts(ctx: ActionContext) {
  const [failing] = await ctx.tx
    .select({ id: calendar.id })
    .from(calendar)
    .where(and(eq(calendar.selected, true), isNotNull(calendar.lastError)))
    .limit(1);
  const [troubled] = await ctx.tx
    .select({ email: googleAccount.email })
    .from(googleAccount)
    .where(or(ne(googleAccount.status, "ok"), isNotNull(googleAccount.lastError)))
    .limit(1);
  if (failing || troubled) return;
  const rows = await ctx.tx
    .update(notification)
    .set({ state: "done", updatedAt: ctx.now })
    .where(
      and(
        ne(notification.state, "done"),
        sql`starts_with(${notification.dedupeKey}, 'calendar.sync_failed:')`,
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
    await dropMail(ctx, mailMessage, mailId);
    await dropMail(ctx, mailThread, mailId);
    // Kept drafts lose their account with it (the key is set to null) and wait for a new From.
    if (!i.keepDrafts) await dropMail(ctx, mailDraft, mailId);
    await closeMailAlerts(ctx, mailId, false);
    await ctx.tx.delete(mailAccount).where(eq(mailAccount.id, mailId));
    const gone = await ctx.tx
      .delete(googleAccount)
      .where(eq(googleAccount.email, email))
      .returning({ email: googleAccount.email, token: googleAccount.refreshToken });
    await closeCalendarAlerts(ctx);
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
