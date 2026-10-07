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
import { and, asc, eq, getTableColumns, inArray } from "drizzle-orm";
import { personFor } from "../people/store.ts";
import { once } from "./copies.ts";
import { accountAddresses, addressKey, toAnyOf, yourAddresses } from "./mine.ts";
import { type MailProvider, MailProviderError } from "./provider.ts";

type MessageRow = typeof mailMessage.$inferSelect;

/** Senders that are machines, not people: nobody expects a reply. (Also in 0008_mail_waiting.) */
const AUTOMATED =
  /^(no-?reply|do-?not-?reply|notifications?|notify|mailer-daemon|postmaster|bounces?|alerts?|news(letter)?|updates?|info|hello|support|billing|receipts?|orders?|team|marketing)([+._-][^@]*)?@/i;

type LastMessage = Pick<
  MessageRow,
  "outbound" | "fromAddress" | "labels" | "toAddresses" | "invite" | "bulk"
>;

/**
 * Who the conversation waits on, from its last message: "them" if you sent it (Gmail says so; a
 * From line naming you can be forged); "you" if a person wrote to you directly (to one of `mine`,
 * your addresses by addressKey: not a cc, a list, a newsletter, a notification or a Gmail tab) in
 * Signal, and they're someone you know (`known`: a person in Hearth, as anyone you write to
 * becomes) or Gmail marks it important (D61).
 */
export function waitingOn(
  last: LastMessage,
  mine: ReadonlySet<string>,
  lane: MailLane,
  known: boolean,
): "you" | "them" | null {
  if (last.outbound) return last.labels.includes("SENT") ? "them" : null;
  // Your own email, as it reached another of yours: it waits on no one there.
  if (mine.has(addressKey(last.fromAddress))) return null;
  if (lane !== "signal" || AUTOMATED.test(last.fromAddress)) return null;
  // An invitation is answered on the calendar, not by email.
  if (last.invite) return null;
  if (last.bulk) return null;
  if (last.labels.some((l) => l.startsWith("CATEGORY_") && l !== "CATEGORY_PERSONAL")) return null;
  if (!toAnyOf(last.toAddresses, mine)) return null;
  return known || last.labels.includes("IMPORTANT") ? "you" : null;
}

/**
 * waitingOn with the account's own address, and your others only when they'd make a difference:
 * mail to one of them, or from one of your accounts (your own email cc'd here, before its copy in
 * Sent is saved).
 */
async function waitingFor(
  db: DbOrTx,
  last: LastMessage,
  me: string,
  lane: MailLane,
  known: boolean,
): Promise<"you" | "them" | null> {
  const own = new Set([addressKey(me)]);
  const waiting = waitingOn(last, own, lane, known);
  if (waiting === "you")
    return (await accountAddresses(db)).has(addressKey(last.fromAddress)) ? null : waiting;
  if (waiting || last.outbound) return waiting;
  // Only who it was sent to stands in the way: it may be another of your addresses.
  const ifToYou = waitingOn({ ...last, toAddresses: [{ address: me }] }, own, lane, known);
  return ifToYou ? waitingOn(last, await yourAddresses(db), lane, known) : null;
}

/** Works the conversation's state out again from its messages. Removes it if none are left. */
export async function recomputeThread(ctx: ActionContext, threadId: string): Promise<void> {
  const msgs = await ctx.tx
    .select({ ...getTableColumns(mailMessage), subject: entity.title })
    .from(mailMessage)
    .innerJoin(entity, eq(entity.id, mailMessage.entityId))
    .where(eq(mailMessage.threadId, threadId))
    .orderBy(asc(mailMessage.sentAt), asc(mailMessage.entityId));
  if (msgs.length === 0) {
    // Only ever a conversation: never another kind of record that was passed by mistake.
    await ctx.tx
      .delete(entity)
      .where(
        and(
          eq(entity.id, threadId),
          inArray(
            entity.id,
            ctx.tx
              .select({ id: mailThread.entityId })
              .from(mailThread)
              .where(eq(mailThread.entityId, threadId)),
          ),
        ),
      );
    return;
  }
  const live = msgs.filter((m) => !m.labels.includes("TRASH"));
  // The same email in two of your accounts counts once, and only the copy shown has a say.
  const shown = once(live.length ? live : msgs);
  const last = shown.at(-1)!;
  const any = (label: string) => live.length > 0 && shown.some((m) => m.labels.includes(label));
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
  // Counted, not dated: a new message's date is whatever its sender's clock says.
  const said = thread?.noReplyCount != null && thread.noReplyCount >= shown.length;
  // The conversation is named by its first message, whichever arrived first.
  await updateEntity(ctx, threadId, { title: msgs[0]!.subject }).catch(() => {});
  const known = !last.outbound && Boolean(await personFor(ctx.tx, last.fromAddress.toLowerCase()));
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
      waiting: said || !row ? null : await waitingFor(ctx.tx, last, row.me, lane, known),
      waitingSince: last.sentAt,
    })
    .where(eq(mailThread.entityId, threadId));
}

const withFlags = (labels: string[], add: string[], remove: string[]) => [
  ...new Set([...labels.filter((l) => !remove.includes(l)), ...add]),
];

/**
 * Changes flags on whole conversations, here and now, and queues the change for the provider:
 * on every message in them, or only on `only` (message ids) when given. Returns how many
 * conversations changed.
 */
export async function changeFlags(
  ctx: ActionContext,
  threadIds: string[],
  add: string[],
  remove: string[],
  only?: readonly string[],
): Promise<number> {
  if (threadIds.length === 0) return 0;
  const all = await ctx.tx
    .select()
    .from(mailMessage)
    .where(inArray(mailMessage.threadId, threadIds));
  const msgs = only ? all.filter((m) => only.includes(m.entityId)) : all;
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
    // An email in two of your accounts has a copy in each: the change goes to each account.
    for (const accountId of new Set(touched.map((m) => m.accountId))) {
      const theirs = touched.filter((m) => m.accountId === accountId);
      await ctx.tx.insert(mailOp).values({
        id: newId(),
        accountId,
        threadId,
        providerIds: theirs.map((m) => m.providerId),
        addLabels: add,
        removeLabels: remove,
        undo: Object.fromEntries(theirs.map((m) => [m.providerId, m.labels])),
        createdAt: ctx.now,
      });
    }
    await recomputeThread(ctx, threadId);
    ctx.emit({ kind: "mail.changed", entityId: threadId, payload: { add, remove } });
  }
  return changed;
}

type Op = typeof mailOp.$inferSelect;

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/** The provider takes up to this many messages in one change. */
const MAX_IDS = 1000;

export interface PushResult {
  pushed: number;
  rolledBack: number;
  /** Why pushing stopped early (a slowdown, the network, access): the rest stay queued. */
  stopped: unknown;
}

/**
 * Sends queued flag changes to the provider, oldest first. Changes next to each other that do
 * the same thing (archiving ten conversations) go as one call (D55); never ones further apart,
 * which could reorder an archive and an unarchive. A refusal rolls the change back here (one by
 * one, so a single bad change doesn't undo the rest); anything that may pass (a slowdown, the
 * network, access to reconnect) stops and leaves the changes queued for the next sync.
 */
export async function pushFlags(
  ctx: ActionContext,
  provider: MailProvider,
  account: { id: string; address: string },
): Promise<PushResult> {
  const ops = await ctx.tx
    .select()
    .from(mailOp)
    .where(eq(mailOp.accountId, account.id))
    .orderBy(asc(mailOp.createdAt), asc(mailOp.id));
  const result: PushResult = { pushed: 0, rolledBack: 0, stopped: null };
  const done = (group: Op[]) =>
    ctx.tx.delete(mailOp).where(
      inArray(
        mailOp.id,
        group.map((o) => o.id),
      ),
    );
  const stop = async (group: Op[], err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    for (const op of group)
      await ctx.tx
        .update(mailOp)
        .set({ attempts: op.attempts + 1, lastError: message.slice(0, 500) })
        .where(eq(mailOp.id, op.id));
    result.stopped = err;
    return result;
  };
  const send = (group: Op[]) =>
    provider.modify(
      account.address,
      [...new Set(group.flatMap((o) => o.providerIds))],
      group[0]!.addLabels,
      group[0]!.removeLabels,
    );
  const refused = (err: unknown) => err instanceof MailProviderError && err.permanent;

  for (let i = 0; i < ops.length; ) {
    const group = [ops[i]!];
    let size = ops[i]!.providerIds.length;
    for (let j = i + 1; j < ops.length; j++) {
      const op = ops[j]!;
      if (!sameSet(op.addLabels, group[0]!.addLabels)) break;
      if (!sameSet(op.removeLabels, group[0]!.removeLabels)) break;
      if (size + op.providerIds.length > MAX_IDS) break;
      group.push(op);
      size += op.providerIds.length;
    }
    i += group.length;
    try {
      await send(group);
      result.pushed += group.length;
      await done(group);
      continue;
    } catch (err) {
      if (!refused(err)) return stop(group, err);
      if (group.length === 1) {
        await refuse(ctx, group[0]!, err);
        result.rolledBack++;
        await done(group);
        continue;
      }
    }
    // Refused together: find the one the provider won't take, and keep the rest.
    for (const op of group) {
      try {
        await send([op]);
        result.pushed++;
      } catch (err) {
        if (!refused(err)) return stop([op, ...group.slice(group.indexOf(op) + 1)], err);
        await refuse(ctx, op, err);
        result.rolledBack++;
      }
      await done([op]);
    }
  }
  return result;
}

/** The provider won't take a change: put it back here, and say so. */
async function refuse(ctx: ActionContext, op: Op, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  await rollBack(ctx, op);
  ctx.emit({
    kind: "mail.change_failed",
    entityId: op.threadId,
    payload: { add: op.addLabels, remove: op.removeLabels, error: message.slice(0, 300) },
  });
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
