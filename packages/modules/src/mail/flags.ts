// A conversation's state comes from its messages' flags: in the inbox if any message is, unread
// if any is, and so on. Archiving, starring and the like change the flags here at once and queue
// the same change for the provider (local first); a change the provider refuses is rolled back.
import {
  type DbOrTx,
  entity,
  type MailAddress,
  type MailLane,
  mailAccount,
  mailMessage,
  mailOp,
  mailThread,
} from "@hearth/db";
import { type ActionContext, newId, updateEntity } from "@hearth/kernel";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { MailProvider } from "./provider.ts";

type MessageRow = typeof mailMessage.$inferSelect;

/** Senders that are machines, not people: nobody expects a reply. (Also in 0008_mail_waiting.) */
const AUTOMATED =
  /^(no-?reply|do-?not-?reply|notifications?|notify|mailer-daemon|postmaster|bounces?|alerts?|news(letter)?|updates?|info|hello|support|billing|receipts?|orders?|team|marketing)([+._-][^@]*)?@/i;

/**
 * Who the conversation waits on, from its last message: "them" if you wrote last; "you" if a
 * person wrote to you directly (not a cc, a newsletter, a notification or a Gmail tab) in Signal.
 */
export function waitingOn(
  last: Pick<MessageRow, "outbound" | "fromAddress" | "labels" | "toAddresses">,
  me: string,
  lane: MailLane,
): "you" | "them" | null {
  if (last.outbound) return "them";
  if (lane !== "signal" || AUTOMATED.test(last.fromAddress)) return null;
  if (last.labels.some((l) => l.startsWith("CATEGORY_") && l !== "CATEGORY_PERSONAL")) return null;
  return last.toAddresses.some((a) => a.address === me) ? "you" : null;
}

/** Works the conversation's state out again from its messages. Removes it if none are left. */
export async function recomputeThread(ctx: ActionContext, threadId: string): Promise<void> {
  const msgs = await ctx.tx
    .select()
    .from(mailMessage)
    .where(eq(mailMessage.threadId, threadId))
    .orderBy(asc(mailMessage.sentAt));
  if (msgs.length === 0) {
    await ctx.tx.delete(entity).where(eq(entity.id, threadId));
    return;
  }
  const live = msgs.filter((m) => !m.labels.includes("TRASH"));
  const shown = live.length ? live : msgs;
  const last = shown.at(-1)!;
  const any = (label: string) => live.some((m) => m.labels.includes(label));
  const lastOf = (out: boolean) => shown.filter((m) => m.outbound === out).at(-1)?.sentAt ?? null;
  const people = new Map<string, MailAddress>();
  for (const m of shown) {
    const who = m.outbound
      ? [...m.toAddresses, ...m.ccAddresses]
      : [{ address: m.fromAddress, ...(m.fromName ? { name: m.fromName } : {}) }];
    for (const a of who) if (a.address && !people.has(a.address)) people.set(a.address, a);
  }
  const [row] = await ctx.tx
    .select({ thread: mailThread, me: mailAccount.address })
    .from(mailThread)
    .innerJoin(mailAccount, eq(mailAccount.id, mailThread.accountId))
    .where(eq(mailThread.entityId, threadId));
  const thread = row?.thread;
  // Once you've written in a conversation, it's Signal.
  const lane = msgs.some((m) => m.outbound) ? "signal" : (thread?.lane ?? "signal");
  const said = thread?.noReplyAt && thread.noReplyAt >= last.sentAt;
  // The conversation is named by its first message, whichever arrived first.
  const [first] = await ctx.tx
    .select({ title: entity.title })
    .from(entity)
    .where(eq(entity.id, msgs[0]!.entityId));
  if (first) await updateEntity(ctx, threadId, { title: first.title }).catch(() => {});
  await ctx.tx
    .update(mailThread)
    .set({
      snippet: last.snippet,
      participants: [...people.values()].slice(0, 12),
      lastMessageAt: last.sentAt,
      lastInboundAt: lastOf(false),
      lastOutboundAt: lastOf(true),
      messageCount: shown.length,
      unread: any("UNREAD"),
      starred: any("STARRED"),
      inInbox: any("INBOX"),
      trashed: live.length === 0,
      lane,
      waiting: said || !row ? null : waitingOn(last, row.me, lane),
      waitingSince: last.sentAt,
    })
    .where(eq(mailThread.entityId, threadId));
}

const withFlags = (labels: string[], add: string[], remove: string[]) => [
  ...new Set([...labels.filter((l) => !remove.includes(l)), ...add]),
];

/**
 * Changes flags on whole conversations, here and now, and queues the change for the provider.
 * Returns how many conversations changed.
 */
export async function changeFlags(
  ctx: ActionContext,
  threadIds: string[],
  add: string[],
  remove: string[],
): Promise<number> {
  if (threadIds.length === 0) return 0;
  const msgs = await ctx.tx
    .select()
    .from(mailMessage)
    .where(inArray(mailMessage.threadId, threadIds));
  let changed = 0;
  for (const threadId of new Set(msgs.map((m) => m.threadId))) {
    const mine = msgs.filter((m) => m.threadId === threadId);
    const touched = mine.filter((m) => {
      const next = withFlags(m.labels, add, remove);
      return next.length !== m.labels.length || next.some((l) => !m.labels.includes(l));
    });
    if (touched.length === 0) continue;
    changed++;
    for (const m of touched)
      await ctx.tx
        .update(mailMessage)
        .set({ labels: withFlags(m.labels, add, remove) })
        .where(eq(mailMessage.entityId, m.entityId));
    await ctx.tx.insert(mailOp).values({
      id: newId(),
      accountId: touched[0]!.accountId,
      threadId,
      providerIds: touched.map((m) => m.providerId),
      addLabels: add,
      removeLabels: remove,
      undo: Object.fromEntries(touched.map((m) => [m.providerId, m.labels])),
      createdAt: ctx.now,
    });
    await recomputeThread(ctx, threadId);
    ctx.emit({ kind: "mail.changed", entityId: threadId, payload: { add, remove } });
  }
  return changed;
}

/**
 * Sends queued flag changes to the provider, oldest first. A refusal rolls the change back here;
 * a failure that may pass (offline, rate limits) stops and tries again next sync.
 */
export async function pushFlags(
  ctx: ActionContext,
  provider: MailProvider,
  account: { id: string; address: string },
): Promise<{ pushed: number; rolledBack: number }> {
  const ops = await ctx.tx
    .select()
    .from(mailOp)
    .where(eq(mailOp.accountId, account.id))
    .orderBy(asc(mailOp.createdAt));
  let pushed = 0;
  let rolledBack = 0;
  for (const op of ops) {
    try {
      await provider.modify(account.address, op.providerIds, op.addLabels, op.removeLabels);
      pushed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!(err as { permanent?: boolean }).permanent) {
        await ctx.tx
          .update(mailOp)
          .set({ attempts: op.attempts + 1, lastError: message })
          .where(eq(mailOp.id, op.id));
        break;
      }
      await rollBack(ctx, op);
      rolledBack++;
      ctx.emit({
        kind: "mail.change_failed",
        entityId: op.threadId,
        payload: { add: op.addLabels, remove: op.removeLabels, error: message.slice(0, 300) },
      });
    }
    await ctx.tx.delete(mailOp).where(eq(mailOp.id, op.id));
  }
  return { pushed, rolledBack };
}

/** Undoes one change: flags it added come off again, and flags it took off go back on. */
async function rollBack(ctx: ActionContext, op: typeof mailOp.$inferSelect) {
  const msgs = await ctx.tx
    .select()
    .from(mailMessage)
    .where(
      and(eq(mailMessage.accountId, op.accountId), inArray(mailMessage.providerId, op.providerIds)),
    );
  for (const m of msgs) {
    const before = op.undo[m.providerId] ?? [];
    const labels = withFlags(
      m.labels,
      op.removeLabels.filter((l) => before.includes(l)),
      op.addLabels.filter((l) => !before.includes(l)),
    );
    await ctx.tx.update(mailMessage).set({ labels }).where(eq(mailMessage.entityId, m.entityId));
  }
  await recomputeThread(ctx, op.threadId).catch(() => {});
}

/** Sets messages' flags to what the provider says, and refreshes their conversations. */
export async function setFlags(
  ctx: ActionContext,
  rows: MessageRow[],
  labels: Map<string, string[]>,
): Promise<void> {
  const threads = new Set<string>();
  for (const m of rows) {
    const next = labels.get(m.providerId);
    if (!next) continue;
    if (next.length === m.labels.length && next.every((l) => m.labels.includes(l))) continue;
    await ctx.tx
      .update(mailMessage)
      .set({ labels: next })
      .where(eq(mailMessage.entityId, m.entityId));
    threads.add(m.threadId);
  }
  for (const t of threads) await recomputeThread(ctx, t);
}

export async function pendingChanges(db: DbOrTx, accountId: string): Promise<number> {
  const rows = await db
    .select({ id: mailOp.id })
    .from(mailOp)
    .where(eq(mailOp.accountId, accountId));
  return rows.length;
}
