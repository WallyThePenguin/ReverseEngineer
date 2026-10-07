// One account's share of a sync: what changed at the provider, brought in a message at a time and
// saved as it comes. What's left when Gmail says slow down (or anything else stops it) is kept on
// the cursor as `pending`, so the next sync picks up there and nothing is fetched twice (D55). A
// message that fails is parked beside the queue, so new mail never waits behind it (6.2).
import { mailAccount, mailMessage, mailQuarantine } from "@hearth/db";
import { type ActionContext, ActionError, savepoint } from "@hearth/kernel";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { setFlags } from "./flags.ts";
import { accountAddresses, addressKey, readOnce, yourAddresses } from "./mine.ts";
import { type MailChange, type MailProvider, MailProviderError, type RawMail } from "./provider.ts";
import { type AccountRow, leftOut, removeMail, type Saved, saveMail } from "./store.ts";
import { forget, LOOK_ASIDE_MS, QUARANTINE_AFTER, quarantine, release } from "./sync-aside.ts";
import { type Parked, readCursor, type SyncCursor, writeCursor } from "./sync-cursor.ts";

/** Calls to the provider per sync, so no transaction stays open long; more follow at once. */
export const CALLS_PER_SYNC = 50;
/**
 * A download that timed out, or that Gmail's servers failed on, more than once waits this long
 * before it's tried again, and counts against the message at most this often: a huge message on
 * a slow line is set aside after twenty minutes or so, but a few bad minutes on the line aren't.
 */
export const TIMEOUT_STRIKE_MS = 10 * 60_000;
/** Server errors in one sync, with nothing yet to tell an outage by, before it's taken for one. */
const DOUBTS = 3;
/** The newest messages Hearth has, of which the smallest is downloaded to tell an outage by. */
const PROBE_AMONG = 20;

type Stuck = "refused" | "timeout" | "server";

/**
 * A failure that may be about one message rather than the provider or the network: the provider
 * won't hand it over, it couldn't arrive in time, or the provider's servers fail on it. It mustn't
 * hold up the rest (6.2). A network error is the line's, never the message's.
 */
function stuckOn(err: unknown): Stuck | null {
  if (!(err instanceof MailProviderError)) return null;
  if (err.kind === "refused") return "refused";
  if (err.kind !== "transient" || err.reason === "network") return null;
  return err.reason === "timeout" ? "timeout" : "server";
}

/**
 * A refusal before anything else worked in this sync could be the account's (Gmail turned off for
 * it, say) rather than the message's: one cheap call tells which, and throws if it's the account,
 * so trouble with the account stops the sync instead of setting its mail aside one by one.
 */
async function onlyThisOne(provider: MailProvider, account: AccountRow, work: Work) {
  if (work.progressed) return;
  await provider.check(account.address);
  work.progressed = true;
}

export interface Work {
  added: number;
  removed: number;
  more: boolean;
  /** Some call to the provider worked. */
  progressed: boolean;
  /** What stopped it early (a slowdown, the network...); what's done is kept. */
  stopped: unknown;
  /** Nothing came in while mail waits to be tried again: not a failure, but not synced either. */
  held?: boolean;
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
  const now = ctx.now.getTime();
  if (now - c.lookedAside >= LOOK_ASIDE_MS) {
    await release(ctx, account.id, c);
    c.lookedAside = now;
  }
  // Parked mail that's due again, taken before this sync parks any: it's tried after new mail.
  const due = Object.entries(c.parked)
    .filter(([, p]) => p.at <= now)
    .sort(([, a], [, b]) => a.at - b.at)
    .map(([id]) => id);
  // Your addresses, read once for the batch (and again if that read fails): your accounts', and
  // for mail you sent, every address you've sent from too (Gmail's "Send mail as").
  const yours = readOnce(() => accountAddresses(ctx.tx));
  const sentAs = readOnce(() => yourAddresses(ctx.tx));
  const one: One = { ctx, provider, account, c, work, doubts: [], yours, sentAs };
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
    while (c.pending.length && calls-- > 0)
      await bringOne(one, c.pending[0]!, c.quiet, () => c.pending.shift());
    for (const id of due) {
      const p = c.parked[id];
      if (p && calls-- > 0) await bringOne(one, id, p.quiet === true, () => delete c.parked[id], p);
    }
    while (c.relabel.length && calls-- > 0) {
      const id = c.relabel[0]!;
      let labels: string[] | null;
      try {
        labels = await provider.labels(account.address, id);
      } catch (err) {
        // Only its flags were to be looked up: they stay as they are rather than block the rest.
        // Gmail's servers failing may pass, so that look-up waits for the next sync instead.
        const stuck = stuckOn(err);
        if (!stuck || stuck === "server") throw err;
        if (stuck === "refused") await onlyThisOne(provider, account, work);
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
  await settle(one);
  const parked = Object.values(c.parked);
  work.more ||= c.pending.length + c.relabel.length > 0 || parked.some((p) => p.at <= now);
  work.held = !work.stopped && work.added === 0 && parked.some((p) => p.at > now);
  await ctx.tx
    .update(mailAccount)
    .set({ cursor: writeCursor(c) })
    .where(eq(mailAccount.id, account.id));
  return work;
}

/** A message Gmail's servers failed on, before the sync could tell whether they fail on all. */
interface Doubt {
  id: string;
  quiet: boolean;
  err: unknown;
  /** How it was parked, if it was. */
  parked?: Parked;
}

interface One {
  ctx: ActionContext;
  provider: MailProvider;
  account: AccountRow;
  c: SyncCursor;
  work: Work;
  /**
   * Whether Gmail's servers hand out mail in this sync: true once a download (or a look-up) has
   * worked, false if a look-up failed too, null with nothing to look up; undefined until asked.
   */
  serving?: boolean | null;
  doubts: Doubt[];
  /** Your accounts' addresses, looked up once a sync needs them (mine.ts). */
  yours: () => Promise<Set<string>>;
  /** And every address you've sent from: read only for mail you sent. */
  sentAs: () => Promise<Set<string>>;
}

/**
 * Fetches and saves one message; `done` takes it off its list, and `again` is how it was parked
 * if it was. One that fails is parked beside the queue, never in front of new mail. A timeout
 * also stops the sync, since it may be the line rather than the message; anything else that
 * isn't about this message goes up with the message still where it was.
 */
async function bringOne(one: One, id: string, quiet: boolean, done: () => void, again?: Parked) {
  const { ctx, provider, account, work } = one;
  let raw: RawMail | null;
  try {
    raw = await provider.fetch(account.address, id);
  } catch (err) {
    const stuck = stuckOn(err);
    if (!stuck) throw err;
    if (stuck === "refused") await onlyThisOne(provider, account, work);
    done();
    const doubt = { id, quiet, err, ...(again ? { parked: again } : {}) };
    if (stuck === "server" && !(await itsOwn(one, doubt))) return;
    await park(one, id, quiet, err, stuck !== "refused", again);
    if (stuck === "timeout") throw err;
    return;
  }
  done();
  one.serving = true;
  work.progressed = true;
  let saved: Saved | null = null;
  if (raw) {
    const mail = raw;
    try {
      // A message that won't save is undone on its own; the rest carry on (6.2).
      saved = await savepoint(ctx, (sp) => saveMail(sp, account, mail, one.yours, one.sentAs));
    } catch (err) {
      await park(one, id, quiet, err, false, again);
      return;
    }
  }
  // It failed before, and it's in now (or gone from Gmail): its failures are forgotten.
  if (again) await forget(ctx, account.id, id);
  if (!saved?.added) return;
  work.added++;
  // Your own email cc'd to this account, saved before its copy in Sent, isn't news either.
  const from = addressKey(saved.parsed?.from?.address ?? "");
  if (!quiet && !saved.outbound && !(await one.yours()).has(from))
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

/**
 * Whether a server error is the message's own: Gmail's servers hand out other mail in this sync.
 * If they don't, it may be an outage, and the sync stops (see settle). With nothing to tell by
 * yet, the message waits for the rest of the sync to tell, up to DOUBTS of them.
 */
async function itsOwn(one: One, d: Doubt): Promise<boolean> {
  one.doubts.push(d);
  const up = await serving(one);
  if (up) one.doubts.pop();
  else if (up === false || one.doubts.length >= DOUBTS) throw d.err;
  return up === true;
}

/**
 * Whether Gmail's servers hand out mail: they download one Hearth already has, whole, as the
 * failed download asked (a look-up of its flags can work while downloads fail). The smallest of
 * the newest, so its size can't make it time out. With none to try, or it gone from Gmail, it
 * can't tell (null).
 */
async function serving(one: One): Promise<boolean | null> {
  if (one.serving !== undefined) return one.serving;
  one.serving = null;
  const recent = await one.ctx.tx
    .select({ id: mailMessage.providerId, attachments: mailMessage.attachments })
    .from(mailMessage)
    .where(eq(mailMessage.accountId, one.account.id))
    .orderBy(desc(mailMessage.entityId))
    .limit(PROBE_AMONG);
  const size = (m: (typeof recent)[number]) => m.attachments.reduce((n, a) => n + a.size, 0);
  const known = recent.reduce<(typeof recent)[number] | undefined>(
    (least, m) => (least && size(least) <= size(m) ? least : m),
    undefined,
  );
  if (!known) return null;
  try {
    if (await one.provider.fetch(one.account.address, known.id)) one.serving = true;
  } catch (err) {
    // A slowdown, the network or the account itself stops the sync, as anywhere else.
    const stuck = stuckOn(err);
    if (stuck !== "server" && stuck !== "timeout") throw err;
    one.serving = false;
  }
  return one.serving;
}

/**
 * Decides the server errors met before the sync could tell whether Gmail's servers hand out mail.
 * If they do, the errors were the messages' own: each is parked with a strike. If not, it may be
 * an outage: each waits where it was, with no strike, and the sync stops, which counts toward the
 * alert (as it did before mail was parked).
 */
async function settle(one: One) {
  const doubts = one.doubts.splice(0);
  if (one.serving) {
    for (const d of doubts) await park(one, d.id, d.quiet, d.err, true, d.parked);
    return;
  }
  for (const d of doubts) if (d.parked) one.c.parked[d.id] = d.parked;
  one.c.pending.unshift(...doubts.filter((d) => !d.parked).map((d) => d.id));
  if (doubts[0]) one.work.stopped ??= doubts[0].err;
}

/**
 * Parks a message that failed, to be tried again after new mail. A first failure is tried again
 * next round, so a one-off costs seconds; a timeout or a server error (`slow`) after that waits
 * TIMEOUT_STRIKE_MS. After QUARANTINE_AFTER tries it's set aside (sync-aside.ts).
 */
async function park(
  one: One,
  id: string,
  quiet: boolean,
  err: unknown,
  slow: boolean,
  again?: Parked,
) {
  const spacing = slow ? TIMEOUT_STRIKE_MS : 0;
  if ((await quarantine(one.ctx, one.account.id, id, err, spacing)) >= QUARANTINE_AFTER) return;
  const at = one.ctx.now.getTime() + (again ? spacing : 0);
  one.c.parked[id] = { at, ...(quiet ? { quiet: true as const } : {}) };
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
    } else if ((x.added || x.inboxed) && !left && !skip.has(x.id) && !(x.id in c.parked))
      c.pending.push(x.id);
    // Otherwise only flags changed, on mail Hearth doesn't keep: nothing to bring in.
  }
  work.removed += await removeMail(ctx, account.id, drop);
  await setFlags(
    ctx,
    known.filter((k) => flags.has(k.providerId)),
    flags,
  );
}
