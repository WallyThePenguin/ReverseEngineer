// Pacing Google calls (D55). Google counts "units" per account per minute (a Gmail message fetch
// is 5, a send 100), and Hearth's server, worker and Jarvis all spend from the same allowance.
// So every call is written down before it goes out, in the database the three processes share,
// and a call that would go over this minute's budget is held back instead of sent.
import { type DbOrTx, googleQuota, googleSpend } from "@hearth/db";
import { and, asc, eq, gt, lt, sql } from "drizzle-orm";
import { GoogleApiError } from "./errors.ts";

export type GoogleService = "gmail" | "calendar";

/** Units per rolling minute for everyday calls, plus headroom only the owner's own sends use. */
export interface Allowance {
  units: number;
  headroom: number;
}

export const WINDOW_MS = 60_000;
/** The shortest pause after Google says slow down: its limits are per minute. */
export const MIN_PAUSE_MS = 60_000;
/**
 * The pause for Gmail's sending limit, which it shares with Gmail on the phone and can hold for
 * hours: only a send waits for it, so the rest of Gmail goes on.
 */
export const SEND_PAUSE = "gmail-send";

export const ALLOWANCES: Record<GoogleService, Allowance> = {
  // Gmail turned Hearth away at about 510-600 units a minute (2026-10-04), far under the
  // documented 15,000. Everyday work stays under 400, and 100 more are kept for a send.
  gmail: { units: 400, headroom: 100 },
  // Calendar has its own quota, counted in requests; Hearth makes a handful every few minutes.
  calendar: { units: 240, headroom: 60 },
};

/** What each Gmail call costs, in Google's quota units. */
export const GMAIL_COST = {
  profile: 1,
  history: 2,
  list: 5,
  get: 5,
  batchModify: 50,
  send: 100,
} as const;

export type Take = { ok: true } | { ok: false; paused: boolean; retryAt: number };

/** Where spending and pauses are kept. */
export interface QuotaStore {
  /** Writes down `units` unless a pause holds or they'd take the minute over `limit`. */
  take(account: string, service: string, units: number, limit: number, now: number): Promise<Take>;
  /** Holds every call for this account and service until `until`; `reason` is what Google said. */
  pause(account: string, service: string, until: number, reason?: string): Promise<void>;
  /** When the account and service's pause ends; 0 if there's none. */
  pausedUntil(account: string, service: string): Promise<number>;
}

/** When enough of the spending has aged out of the minute for `need` more units to fit. */
function freedAt(spent: { at: number; units: number }[], need: number): number {
  let freed = 0;
  for (const s of spent) {
    freed += s.units;
    if (freed >= need) return s.at + WINDOW_MS;
  }
  return (spent.at(-1)?.at ?? 0) + WINDOW_MS;
}

/**
 * The shared store: Hearth's database, written in short transactions of its own (never an
 * action's), so other processes see each call at once and nobody waits on an action's locks.
 */
export class DbQuotaStore implements QuotaStore {
  private readonly db: DbOrTx;
  constructor(db: DbOrTx) {
    this.db = db;
  }

  take(account: string, service: string, units: number, limit: number, now: number) {
    return this.db.transaction(async (tx): Promise<Take> => {
      const key = and(eq(googleQuota.account, account), eq(googleQuota.service, service));
      // The quota row is the lock: calls for one account and service are counted one at a time.
      let [row] = await tx.select().from(googleQuota).where(key).for("update");
      if (!row) {
        await tx.insert(googleQuota).values({ account, service }).onConflictDoNothing();
        [row] = await tx.select().from(googleQuota).where(key).for("update");
      }
      const paused = row?.pausedUntil?.getTime() ?? 0;
      if (paused > now) return { ok: false, paused: true, retryAt: paused };
      const mine = and(eq(googleSpend.account, account), eq(googleSpend.service, service));
      await tx
        .delete(googleSpend)
        .where(and(mine, lt(googleSpend.at, new Date(now - 5 * WINDOW_MS))));
      const rows = await tx
        .select({ at: googleSpend.at, units: googleSpend.units })
        .from(googleSpend)
        .where(and(mine, gt(googleSpend.at, new Date(now - WINDOW_MS))))
        .orderBy(asc(googleSpend.at));
      const spent = rows.map((r) => ({ at: r.at.getTime(), units: r.units }));
      const total = spent.reduce((n, s) => n + s.units, 0);
      if (total + units > limit)
        return { ok: false, paused: false, retryAt: freedAt(spent, total + units - limit) };
      await tx.insert(googleSpend).values({ account, service, at: new Date(now), units });
      return { ok: true };
    });
  }

  async pause(account: string, service: string, until: number, reason?: string) {
    const at = new Date(until);
    await this.db
      .insert(googleQuota)
      .values({ account, service, pausedUntil: at, reason: reason ?? null })
      .onConflictDoUpdate({
        target: [googleQuota.account, googleQuota.service],
        // A shorter pause never cuts a longer one short; the latest word from Google is kept.
        set: {
          pausedUntil: sql`greatest(${googleQuota.pausedUntil}, excluded.paused_until)`,
          reason: sql`coalesce(excluded.reason, ${googleQuota.reason})`,
        },
      });
  }

  async pausedUntil(account: string, service: string) {
    const [row] = await this.db
      .select({ until: googleQuota.pausedUntil })
      .from(googleQuota)
      .where(and(eq(googleQuota.account, account), eq(googleQuota.service, service)));
    return row?.until?.getTime() ?? 0;
  }
}

/** For a client with no database (some tests): pacing within this process only. */
export class MemoryQuotaStore implements QuotaStore {
  private readonly spent = new Map<string, { at: number; units: number }[]>();
  private readonly paused = new Map<string, number>();

  async take(account: string, service: string, units: number, limit: number, now: number) {
    const key = `${account} ${service}`;
    const paused = this.paused.get(key) ?? 0;
    if (paused > now) return { ok: false, paused: true, retryAt: paused } as const;
    const spent = (this.spent.get(key) ?? []).filter((s) => s.at > now - WINDOW_MS);
    const total = spent.reduce((n, s) => n + s.units, 0);
    if (total + units > limit)
      return { ok: false, paused: false, retryAt: freedAt(spent, total + units - limit) } as const;
    this.spent.set(key, [...spent, { at: now, units }]);
    return { ok: true } as const;
  }

  async pause(account: string, service: string, until: number) {
    const key = `${account} ${service}`;
    this.paused.set(key, Math.max(until, this.paused.get(key) ?? 0));
  }

  async pausedUntil(account: string, service: string) {
    return this.paused.get(`${account} ${service}`) ?? 0;
  }
}

export class GoogleBudget {
  private readonly store: QuotaStore;
  private readonly allowances: Record<GoogleService, Allowance>;

  constructor(store: QuotaStore, allowances: Partial<Record<GoogleService, Allowance>> = {}) {
    this.store = store;
    this.allowances = { ...ALLOWANCES, ...allowances };
  }

  /**
   * Writes down a call's cost, or throws: "rate_limited" while a pause Google asked for holds,
   * "paced" when the minute's budget is spent. `priority` (the owner sending mail) may use the
   * headroom everyday calls leave.
   */
  async spend(
    account: string,
    service: GoogleService,
    units: number,
    priority: boolean,
    now: number,
  ): Promise<void> {
    const a = this.allowances[service];
    const r = await this.store.take(
      account,
      service,
      units,
      a.units + (priority ? a.headroom : 0),
      now,
    );
    if (r.ok) return;
    const retryAfterMs = Math.max(0, r.retryAt - now);
    if (r.paused)
      throw new GoogleApiError(0, `Google asked Hearth to slow down ${service} for ${account}.`, {
        kind: "rate_limited",
        reason: "paused",
        retryAfterMs,
      });
    throw new GoogleApiError(0, `Hearth is pacing ${service} for ${account} this minute.`, {
      kind: "paced",
      reason: "budget",
      retryAfterMs,
    });
  }

  /** Throws "rate_limited" while Gmail's sending limit holds the account (SEND_PAUSE). */
  async maySend(account: string, now: number): Promise<void> {
    const until = await this.store.pausedUntil(account, SEND_PAUSE);
    if (until > now)
      throw new GoogleApiError(0, `Gmail won't take mail from ${account} for now.`, {
        kind: "rate_limited",
        reason: "paused",
        retryAfterMs: until - now,
      });
  }

  pause(
    account: string,
    service: GoogleService | typeof SEND_PAUSE,
    until: number,
    reason?: string,
  ): Promise<void> {
    return this.store.pause(account, service, until, reason);
  }
}
