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
import { type ActionContext, ActionError, defineAction } from "@hearth/kernel";
import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { dropCalendars, handOver } from "../calendar/calendars.ts";
import { closeCalendarAlerts } from "../calendar/health.ts";
import { BLOB_SERVICE, type BlobStore } from "../mail/blobs.ts";
import { recomputeThread } from "../mail/flags.ts";
import { accountId, holdSyncs } from "../mail/sync.ts";
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

/** Whether Postgres said one of `codes`, wherever the driver wrapped it. */
function saidAny(err: unknown, codes: ReadonlySet<string>): boolean {
  for (let e = err; e instanceof Error; e = e.cause)
    if ("code" in e && codes.has(String(e.code))) return true;
  return false;
}
/** Postgres stopped waiting, on a lock or for the statement. */
const STOPPED_WAITING = new Set(["57014", "55P03"]);
/** Postgres picked this to undo in a deadlock (a calendar sync noting the account's health). */
const DEADLOCK = new Set(["40P01"]);
const syncing = () => new ActionError("conflict", "Google is syncing; try again in a moment.");

/**
 * Waits for any sync that's running to finish, and holds every account's off until this is done.
 * Every Google account's too, not only those with mail here yet: an account's first sync makes
 * its mail account, and until that sync is done no one else can see it.
 */
async function holdAll(ctx: ActionContext) {
  const [mail, google] = await Promise.all([
    ctx.tx.select({ id: mailAccount.id }).from(mailAccount),
    ctx.tx.select({ email: googleAccount.email }).from(googleAccount),
  ]);
  const ids = new Set([
    ...mail.map((a) => a.id),
    ...google.map((g) => accountId("gmail", g.email)),
  ]);
  await holdSyncs(ctx, [...ids]);
}

export const disconnectAction = defineAction({
  name: "google.disconnect",
  description:
    "Forget a Google account: its tokens, calendars and mail leave Hearth. keepDrafts keeps its unsent drafts, to send from another account.",
  input: z.object({ email: z.string().email(), keepDrafts: z.boolean().default(false) }),
  risk: "internal",
  callers: ["owner"],
  async handler(i, ctx) {
    try {
      return await disconnect(i, ctx);
    } catch (err) {
      if (saidAny(err, DEADLOCK)) throw syncing();
      throw err;
    }
  },
});

async function disconnect(i: { email: string; keepDrafts: boolean }, ctx: ActionContext) {
  const email = i.email.toLowerCase();
  try {
    // A sync running now may be filing mail into this account's conversations, which a sync of
    // another account can join too: none of its mail may go with them, never to be fetched again.
    await holdAll(ctx);
    // And a sync starting now waits until it's gone, rather than make its mail account again.
    await ctx.tx.select().from(googleAccount).where(eq(googleAccount.email, email)).for("update");
  } catch (err) {
    // Only here is waiting too long a sync's doing. Later on (removing a very large account's
    // mail, say) it's itself, and logged as a failure.
    if (saidAny(err, STOPPED_WAITING)) throw syncing();
    throw err;
  }
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
  // Its mail in the other accounts' conversations (a copy that joined one, an answer that came
  // only here) goes too; those are worked out again, and go if nothing's left.
  const joined = await ctx.tx
    .selectDistinct({ id: mailMessage.threadId })
    .from(mailMessage)
    .innerJoin(mailThread, eq(mailThread.entityId, mailMessage.threadId))
    .where(and(eq(mailMessage.accountId, mailId), ne(mailThread.accountId, mailId)));
  await dropMail(ctx, mailMessage, mailId);
  await ctx.tx.delete(mailOp).where(eq(mailOp.accountId, mailId));
  await dropMail(ctx, mailThread, mailId);
  // Kept drafts lose their account with it (the key is set to null) and wait for a new From.
  if (!i.keepDrafts) await dropMail(ctx, mailDraft, mailId);
  await closeMailAlerts(ctx, mailId, false);
  await ctx.tx.delete(mailAccount).where(eq(mailAccount.id, mailId));
  // Worked out once the account's gone, as its address is no longer one of yours.
  for (const id of new Set([...shared, ...joined.map((j) => j.id)])) await recomputeThread(ctx, id);
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
}

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
