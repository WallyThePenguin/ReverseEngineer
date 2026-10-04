// One account's share of a sync: what changed at the provider, brought in a message at a time and
// saved as it comes. What's left when Gmail says slow down (or anything else stops it) is kept on
// the cursor as `pending`, so the next sync picks up there and nothing is fetched twice (D55).
import { mailAccount, mailMessage, mailQuarantine } from "@hearth/db";
import { type ActionContext, ActionError, savepoint } from "@hearth/kernel";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { setFlags } from "./flags.ts";
import { type MailChange, type MailProvider, MailProviderError, type RawMail } from "./provider.ts";
import { type AccountRow, leftOut, removeMail, saveMail } from "./store.ts";

/** Calls to the provider per sync, so no transaction stays open long; more follow at once. */
export const CALLS_PER_SYNC = 50;
/** A message that fails to save (or to download) this many times is set aside for good. */
export const QUARANTINE_AFTER = 3;
/**
 * A download that timed out counts against the message at most this often: a huge message on a
 * slow line is set aside after half an hour or so, but a few bad minutes on the line aren't.
 */
export const TIMEOUT_STRIKE_MS = 10 * 60_000;

/**
 * A failure that's about one message rather than the provider or the network: the provider won't
 * hand it over, or it couldn't arrive in time. It mustn't hold up the rest (6.2).
 */
function stuckOn(err: unknown): "refused" | "timeout" | null {
  if (!(err instanceof MailProviderError)) return null;
  if (err.kind === "refused") return "refused";
  return err.kind === "transient" && err.reason === "timeout" ? "timeout" : null;
}

/** The cursor as the sync keeps it: the provider's own, plus what's left to do. */
export interface SyncCursor {
  provider: Record<string, unknown>;
  /** New mail still to fetch. */
  pending: string[];
  /** Messages Hearth has whose flags changed, still to look up. */
  relabel: string[];
  /** What's pending is old mail from a first sync, not news. */
  quiet: boolean;
  /** A first sync's progress: messages listed so far, and about how many there are. */
  backfill?: { listed: number; target: number };
}

const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

export function readCursor(raw: Record<string, unknown> | null): SyncCursor {
  const { pending, relabel, quiet, backfill, ...provider } = raw ?? {};
  const b = backfill as SyncCursor["backfill"] | undefined;
  return {
    provider,
    pending: ids(pending),
    relabel: ids(relabel),
    quiet: quiet === true,
    ...(b && typeof b.listed === "number" ? { backfill: b } : {}),
  };
}

export function writeCursor(c: SyncCursor): Record<string, unknown> {
  const left = c.pending.length + c.relabel.length > 0;
  return {
    ...c.provider,
    ...(c.pending.length ? { pending: c.pending } : {}),
    ...(c.relabel.length ? { relabel: c.relabel } : {}),
    ...(left && c.quiet ? { quiet: true } : {}),
    ...(c.backfill && (left || "pageToken" in c.provider) ? { backfill: c.backfill } : {}),
  };
}

export interface Work {
  added: number;
  removed: number;
  more: boolean;
  /** Some call to the provider worked. */
  progressed: boolean;
  /** What stopped it early (a slowdown, the network...); what's done is kept. */
  stopped: unknown;
}

/**
 * Brings in what changed since the cursor, at most CALLS_PER_SYNC calls' worth. Only new mail is
 * fetched (and mail that came back to the inbox); flag changes on mail Hearth doesn't keep are
 * ignored, and flags come from the provider's change list when it says them.
 */
export async function bringIn(
  ctx: ActionContext,
  provider: MailProvider,
  account: AccountRow,
): Promise<Work> {
  const c = readCursor(account.cursor ?? null);
  const work: Work = { added: 0, removed: 0, more: false, progressed: false, stopped: null };
  const retry: string[] = [];
  try {
    if (c.pending.length + c.relabel.length === 0) {
      const changes = await provider.changes(
        account.address,
        account.cursor === null ? null : c.provider,
      );
      work.progressed = true;
      c.provider = changes.cursor;
      // A first sync is history, not news: it isn't announced (so Jarvis doesn't look at it).
      c.quiet = account.cursor === null || Boolean(changes.backfill) || Boolean(changes.restarted);
      if (changes.backfill) c.backfill = changes.backfill;
      work.more = changes.more;
      work.removed += await removeMail(ctx, account.id, changes.removed);
      await sort(ctx, account, changes.changed, c, work);
    } else work.more = true;
    let calls = CALLS_PER_SYNC;
    while (c.pending.length && calls-- > 0) {
      const id = c.pending[0]!;
      let raw: RawMail | null;
      try {
        raw = await provider.fetch(account.address, id);
      } catch (err) {
        // One message that won't download goes to the back and is set aside after a few tries,
        // so it never blocks what came after it. A timeout may be the line rather than the
        // message, so the sync stops there for now.
        const stuck = stuckOn(err);
        if (!stuck) throw err;
        c.pending.shift();
        const spacing = stuck === "timeout" ? TIMEOUT_STRIKE_MS : 0;
        if ((await quarantine(ctx, account.id, id, err, spacing)) < QUARANTINE_AFTER)
          retry.push(id);
        if (stuck === "timeout") throw err;
        continue;
      }
      c.pending.shift();
      work.progressed = true;
      if (!raw) continue;
      try {
        // A message that won't save is undone on its own; the rest carry on (6.2).
        const saved = await savepoint(ctx, (sp) => saveMail(sp, account, raw));
        if (!saved?.added) continue;
        work.added++;
        if (!c.quiet && !saved.outbound)
          ctx.emit({
            kind: "mail.received",
            entityId: saved.id,
            payload: {
              threadId: saved.threadId,
              from: saved.parsed?.from?.address ?? "",
              subject: saved.parsed?.subject ?? "",
            },
          });
      } catch (err) {
        if ((await quarantine(ctx, account.id, id, err)) < QUARANTINE_AFTER) retry.push(id);
      }
    }
    while (c.relabel.length && calls-- > 0) {
      const id = c.relabel[0]!;
      let labels: string[] | null;
      try {
        labels = await provider.labels(account.address, id);
      } catch (err) {
        // Only its flags were to be looked up: they stay as they are rather than block the rest.
        const stuck = stuckOn(err);
        if (!stuck) throw err;
        c.relabel.shift();
        if (stuck === "timeout") throw err;
        continue;
      }
      c.relabel.shift();
      work.progressed = true;
      const [row] = await ctx.tx
        .select()
        .from(mailMessage)
        .where(and(eq(mailMessage.accountId, account.id), eq(mailMessage.providerId, id)));
      if (!row) continue;
      if (!labels || leftOut(labels)) work.removed += await removeMail(ctx, account.id, [id]);
      else await setFlags(ctx, [row], new Map([[id, labels]]));
    }
  } catch (err) {
    // The provider (or Google's client) said no: keep what's done. Anything else is Hearth's own
    // trouble, maybe with the transaction itself, so it goes up and the batch is undone.
    if (!(err instanceof MailProviderError || err instanceof ActionError)) throw err;
    work.stopped = err;
  }
  c.pending.push(...retry);
  work.more ||= c.pending.length + c.relabel.length > 0;
  await ctx.tx
    .update(mailAccount)
    .set({ cursor: writeCursor(c) })
    .where(eq(mailAccount.id, account.id));
  return work;
}

/** Sorts a batch of changes: flags to set now, mail to fetch, flags to look up. */
async function sort(
  ctx: ActionContext,
  account: AccountRow,
  changed: MailChange[],
  c: SyncCursor,
  work: Work,
) {
  if (changed.length === 0) return;
  const all = changed.map((x) => x.id);
  const known = await ctx.tx
    .select()
    .from(mailMessage)
    .where(and(eq(mailMessage.accountId, account.id), inArray(mailMessage.providerId, all)));
  const setAside = await ctx.tx
    .select({ id: mailQuarantine.providerId })
    .from(mailQuarantine)
    .where(
      and(
        eq(mailQuarantine.accountId, account.id),
        inArray(mailQuarantine.providerId, all),
        gte(mailQuarantine.attempts, QUARANTINE_AFTER),
      ),
    );
  const have = new Set(known.map((k) => k.providerId));
  const skip = new Set(setAside.map((q) => q.id));
  const flags = new Map<string, string[]>();
  const drop: string[] = [];
  for (const x of changed) {
    const left = x.labels !== null && leftOut(x.labels);
    if (have.has(x.id)) {
      if (x.labels === null) c.relabel.push(x.id);
      else if (left) drop.push(x.id);
      else flags.set(x.id, x.labels);
    } else if ((x.added || x.inboxed) && !left && !skip.has(x.id)) c.pending.push(x.id);
    // Otherwise only flags changed, on mail Hearth doesn't keep: nothing to bring in.
  }
  work.removed += await removeMail(ctx, account.id, drop);
  await setFlags(
    ctx,
    known.filter((k) => flags.has(k.providerId)),
    flags,
  );
}

/**
 * Notes a message that failed to save or download. Returns how many times it has; a failure
 * within `spacingMs` of the last counted one is noted but not counted.
 */
async function quarantine(
  ctx: ActionContext,
  accountId: string,
  providerId: string,
  err: unknown,
  spacingMs = 0,
) {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  const counts = sql`${mailQuarantine.lastFailedAt} <= ${new Date(ctx.now.getTime() - spacingMs)}`;
  const [row] = await ctx.tx
    .insert(mailQuarantine)
    .values({
      accountId,
      providerId,
      attempts: 1,
      lastError: message,
      firstFailedAt: ctx.now,
      lastFailedAt: ctx.now,
    })
    .onConflictDoUpdate({
      target: [mailQuarantine.accountId, mailQuarantine.providerId],
      set: {
        attempts: sql`CASE WHEN ${counts} THEN ${mailQuarantine.attempts} + 1 ELSE ${mailQuarantine.attempts} END`,
        lastError: message,
        lastFailedAt: sql`CASE WHEN ${counts} THEN ${ctx.now} ELSE ${mailQuarantine.lastFailedAt} END`,
      },
    })
    .returning({ attempts: mailQuarantine.attempts });
  return row?.attempts ?? 1;
}
