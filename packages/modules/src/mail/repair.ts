// Originals missing from this PC (a restore without its files, a disk clean-up) are fetched again
// from the mail service: at once when you open one, and in the background, a few a round, in one
// pass a day per account. Files no message needs any more are deleted after that pass (6.6). The
// same pass reads mail from before 0032 for whether it was sent to many at once (6.9).
import { mailAccount, mailMessage, storedFile } from "@hearth/db";
import { type ActionContext, defineAction } from "@hearth/kernel";
import { and, asc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { id } from "../shared.ts";
import { BLOB_SERVICE, type BlobStore } from "./blobs.ts";
import { recomputeThread } from "./flags.ts";
import { isBulk, rawHeaders } from "./mime.ts";
import { type MailProvider, MailProviderError } from "./provider.ts";
import { providerFor } from "./providers.ts";
import type { AccountRow } from "./store.ts";

/** Messages looked at, and originals fetched at most, per round. */
export const REPAIR_SCAN = 200;
export const REPAIR_FETCH = 5;
const DAY_MS = 24 * 3600_000;

type MessageRow = Pick<
  typeof mailMessage.$inferSelect,
  "entityId" | "providerId" | "rawHash" | "bulk" | "threadId"
>;

/**
 * Notes whether a message was sent to many at once, from its original, when that wasn't known
 * yet (mail from before 0032). One that was no longer needs your reply.
 */
async function noteBulk(ctx: ActionContext, m: MessageRow, raw: Buffer) {
  if (m.bulk !== null) return;
  const bulk = isBulk(rawHeaders(raw));
  await ctx.tx.update(mailMessage).set({ bulk }).where(eq(mailMessage.entityId, m.entityId));
  if (bulk) await recomputeThread(ctx, m.threadId);
}

/** Fetches one message's original again. False if the service no longer has it. */
async function restore(
  ctx: ActionContext,
  provider: MailProvider,
  account: AccountRow,
  m: MessageRow,
  urgent: boolean,
): Promise<boolean> {
  const got = await provider.fetch(account.address, m.providerId, urgent);
  if (!got) return false;
  const hash = await ctx.service<BlobStore>(BLOB_SERVICE).put(got.raw);
  // Gmail gives the same bytes each time; if it ever doesn't, the message points at these.
  if (hash !== m.rawHash)
    await ctx.tx
      .update(mailMessage)
      .set({ rawHash: hash })
      .where(eq(mailMessage.entityId, m.entityId));
  await noteBulk(ctx, m, got.raw);
  return true;
}

/**
 * Deletes stored bytes nothing needs any more: no message's original, and no file you added
 * (files/index.ts), even one in the trash, which can come back.
 */
export async function sweepBlobs(ctx: ActionContext): Promise<number> {
  const mail = await ctx.tx.selectDistinct({ hash: mailMessage.rawHash }).from(mailMessage);
  const files = await ctx.tx.selectDistinct({ hash: storedFile.hash }).from(storedFile);
  const keep = new Set([...mail, ...files].map((r) => r.hash));
  return ctx.service<BlobStore>(BLOB_SERVICE).sweep(keep);
}

/**
 * One round's share of an account's daily look for missing originals. Stops at a slowdown or
 * failure, to go on from there next round. Returns how many came back.
 */
export async function repairSome(
  ctx: ActionContext,
  provider: MailProvider,
  account: AccountRow,
): Promise<number> {
  if (account.repairedAt && ctx.now.getTime() - account.repairedAt.getTime() < DAY_MS) return 0;
  const blobs = ctx.service<BlobStore>(BLOB_SERVICE);
  const rows = await ctx.tx
    .select({
      entityId: mailMessage.entityId,
      providerId: mailMessage.providerId,
      rawHash: mailMessage.rawHash,
      bulk: mailMessage.bulk,
      threadId: mailMessage.threadId,
    })
    .from(mailMessage)
    .where(
      and(
        eq(mailMessage.accountId, account.id),
        account.repairFrom ? gt(mailMessage.entityId, account.repairFrom) : undefined,
      ),
    )
    .orderBy(asc(mailMessage.entityId))
    .limit(REPAIR_SCAN);
  let checked: string | null = account.repairFrom;
  let fetched = 0;
  let restored = 0;
  let stopped = false;
  for (const m of rows) {
    if (!(await blobs.has(m.rawHash))) {
      if (fetched === REPAIR_FETCH) {
        stopped = true;
        break;
      }
      fetched++;
      try {
        if (await restore(ctx, provider, account, m, false)) restored++;
      } catch (err) {
        // Gmail won't give this one (a bad id, say): it stays as it is, and the pass goes on.
        // Anything that may pass (a slowdown, the network) waits for the next round.
        if (!(err instanceof MailProviderError && err.kind === "refused")) {
          stopped = true;
          break;
        }
      }
    } else if (m.bulk === null) {
      const raw = await blobs.get(m.rawHash);
      if (raw) await noteBulk(ctx, m, raw);
    }
    checked = m.entityId;
  }
  const done = !stopped && rows.length < REPAIR_SCAN;
  await ctx.tx
    .update(mailAccount)
    .set(done ? { repairFrom: null, repairedAt: ctx.now } : { repairFrom: checked })
    .where(eq(mailAccount.id, account.id));
  if (done) await sweepBlobs(ctx);
  return restored;
}

export const restoreAction = defineAction({
  name: "mail.restore_original",
  description:
    "Fetch a message's original from the mail service again, when this PC's copy is missing. The Mail page does this by itself.",
  input: z.object({ id }),
  risk: "internal",
  callers: ["owner", "system"],
  async handler(i, ctx) {
    const [row] = await ctx.tx
      .select({ m: mailMessage, account: mailAccount })
      .from(mailMessage)
      .innerJoin(mailAccount, eq(mailAccount.id, mailMessage.accountId))
      .where(eq(mailMessage.entityId, i.id));
    if (!row) return { restored: false };
    if (await ctx.service<BlobStore>(BLOB_SERVICE).has(row.m.rawHash)) return { restored: true };
    // You're waiting on it: it may use the budget's headroom.
    const provider = providerFor(ctx, row.account);
    return { restored: await restore(ctx, provider, row.account, row.m, true) };
  },
});
