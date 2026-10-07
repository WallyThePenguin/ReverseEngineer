// Calendar sync: your calendars and their events from a week back to two months ahead, pulled
// from Google every few minutes. Changes become events Jarvis can react to. Calls are paced like
// Gmail's, against Calendar's own quota; when Google asks Hearth to slow down, the account waits
// for the next round instead of failing, and one event that won't save is skipped (D55). How each
// account's calendars are doing is saved after the round, and told once when it's bad (health.ts).
import { startOfLocalDay } from "@hearth/core";
import { calendar, calendarEvent, entity, googleAccount } from "@hearth/db";
import { type ActionContext, getSetting, savepoint } from "@hearth/kernel";
import { and, arrayContains, asc, eq, gt, isNull, lt, ne, notInArray } from "drizzle-orm";
import type { Trouble } from "../connector-health.ts";
import { CalendarApi, type GEvent } from "../google/calendar-api.ts";
import { cleanDeep } from "../google/clean.ts";
import { GOOGLE_SERVICE, GoogleApiError, type GoogleClient, SCOPES } from "../google/client.ts";
import { id } from "../shared.ts";
import { syncCalendarList } from "./calendars.ts";
import { recordCalendarHealth, troubleOf } from "./health.ts";
import { seriesTakeovers } from "./series.ts";
import { emitChange, mapEvent, saveEvent } from "./store.ts";

const DAY_MS = 24 * 3600_000;
export const SYNC_BACK_DAYS = 7;
export const SYNC_AHEAD_DAYS = 60;

export interface SyncResult {
  calendars: number;
  events: number;
  changed: number;
  failed: string[];
  /** Accounts Google asked to slow down (or Hearth's pacing held back): next round. */
  paused: string[];
  /** Events that wouldn't save, left as they were. */
  skipped: number;
}

const slowDown = (err: unknown) => err instanceof GoogleApiError && err.slowDown;
const notFound = (err: unknown) => err instanceof GoogleApiError && err.kind === "not_found";
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function syncWindow(now: Date, tz: string): { from: Date; to: Date } {
  const today = startOfLocalDay(now, tz);
  return {
    from: new Date(today.getTime() - SYNC_BACK_DAYS * DAY_MS),
    to: new Date(today.getTime() + SYNC_AHEAD_DAYS * DAY_MS),
  };
}

/**
 * The task a time block is for, as Hearth marked it at Google, if that task is still here: so a
 * block Google made while Hearth didn't hear back is still known as the task's (D61).
 */
async function blockOf(ctx: ActionContext, g: GEvent): Promise<{ taskId?: string }> {
  const taskId = g.extendedProperties?.private?.hearthTask;
  if (!taskId || !id.safeParse(taskId).success) return {};
  const [row] = await ctx.tx
    .select({ id: entity.id })
    .from(entity)
    .where(and(eq(entity.id, taskId), eq(entity.type, "task"), isNull(entity.deletedAt)));
  return row ? { taskId: row.id } : {};
}

/** Pulls every connected account's selected calendars. One calendar failing doesn't stop the rest. */
export async function syncCalendars(ctx: ActionContext): Promise<SyncResult> {
  const google = ctx.service<GoogleClient>(GOOGLE_SERVICE);
  const api = new CalendarApi(google, ctx.tx);
  const rules = await getSetting(ctx.tx, "owner.dayRules");
  const { from, to } = syncWindow(ctx.now, rules.timeZone);
  const accounts = await ctx.tx
    .select()
    .from(googleAccount)
    .where(
      and(
        ne(googleAccount.status, "revoked"),
        arrayContains(googleAccount.scopes, [...SCOPES.calendar]),
      ),
    )
    // In the order they were connected: the first to see a shared calendar syncs it.
    .orderBy(asc(googleAccount.connectedAt), asc(googleAccount.email));
  const result: SyncResult = {
    calendars: 0,
    events: 0,
    changed: 0,
    failed: [],
    paused: [],
    skipped: 0,
  };
  for (const acct of accounts) {
    const troubles: Trouble[] = [];
    const gone: Trouble[] = [];
    let progressed = false;
    let paused = false;
    const cals = () =>
      ctx.tx
        .select()
        .from(calendar)
        .where(and(eq(calendar.account, acct.email), eq(calendar.selected, true)));
    try {
      await syncCalendarList(ctx, api, acct.email);
    } catch (err) {
      if (slowDown(err)) {
        result.paused.push(acct.email);
        // Tried, awake: a heads-up isn't held for a sync the PC slept through (soon.ts).
        await ctx.tx
          .update(googleAccount)
          .set({ calendarAttemptedAt: ctx.now })
          .where(eq(googleAccount.email, acct.email));
        continue;
      }
      // None of the account's calendars could be read: each says why, in Settings too.
      const message = messageOf(err);
      result.failed.push(`${acct.email}: ${message}`);
      troubles.push(troubleOf(err, `${acct.email}'s calendar list`));
      for (const cal of await cals())
        await ctx.tx.update(calendar).set({ lastError: message }).where(eq(calendar.id, cal.id));
      await recordCalendarHealth(ctx, acct, troubles, false, false);
      continue;
    }
    const selected = await cals();
    for (const cal of selected) {
      let items: Awaited<ReturnType<CalendarApi["events"]>>;
      try {
        items = await api.events(acct.email, cal.googleId, from, to);
      } catch (err) {
        // A slowdown holds every calendar of the account: the rest wait for the next round.
        if (slowDown(err)) {
          result.paused.push(acct.email);
          paused = true;
          break;
        }
        const message = messageOf(err);
        result.failed.push(`${cal.title}: ${message}`);
        (notFound(err) ? gone : troubles).push(troubleOf(err, cal.title));
        await ctx.tx.update(calendar).set({ lastError: message }).where(eq(calendar.id, cal.id));
        continue;
      }
      result.calendars++;
      progressed = true;
      const seen: string[] = [];
      const mapped = items.map((g) => ({ g, m: mapEvent(cal.id, cleanDeep(g), rules.timeZone) }));
      const listed = mapped.flatMap(({ m }) => (m ? [m] : []));
      // A repeating meeting edited at Google: its new occurrences keep the old rows.
      const takeovers = await seriesTakeovers(ctx.tx, cal.id, listed, { from, to });
      // Rows a takeover couldn't save to: still Google's, so not taken for deleted.
      const kept: string[] = [];
      for (const { g, m } of mapped) {
        if (!m) continue;
        // Seen even if it won't save, so it isn't taken for deleted at Google.
        seen.push(g.id);
        result.events++;
        let saved: Awaited<ReturnType<typeof saveEvent>>;
        try {
          saved = await savepoint(ctx, async (sp) =>
            saveEvent(sp, m, { ...(await blockOf(sp, g)), replaces: takeovers.get(g.id) }),
          );
        } catch {
          result.skipped++;
          const old = takeovers.get(g.id);
          if (old) kept.push(old);
          continue;
        }
        if (saved.change && m.endsAt > ctx.now) {
          result.changed++;
          emitChange(ctx, saved.id, saved.change, m);
        }
      }
      // Anything in the window Google no longer lists was deleted there.
      const missing = await ctx.tx
        .select({ id: calendarEvent.entityId, title: entity.title, r: calendarEvent })
        .from(calendarEvent)
        .innerJoin(entity, eq(entity.id, calendarEvent.entityId))
        .where(
          and(
            eq(calendarEvent.calendarId, cal.id),
            ne(calendarEvent.status, "cancelled"),
            // Strictly inside, as Google lists them: an all-day event that ends as the window
            // starts isn't listed, and isn't gone either.
            gt(calendarEvent.endsAt, from),
            lt(calendarEvent.startsAt, to),
            ...(seen.length ? [notInArray(calendarEvent.googleId, seen)] : []),
            ...(kept.length ? [notInArray(calendarEvent.entityId, kept)] : []),
          ),
        );
      for (const x of missing) {
        await ctx.tx
          .update(calendarEvent)
          .set({ status: "cancelled" })
          .where(eq(calendarEvent.entityId, x.id));
        if (x.r.endsAt > ctx.now) {
          result.changed++;
          emitChange(ctx, x.id, "cancelled", { ...x.r, title: x.title, status: "cancelled" });
        }
      }
      await ctx.tx
        .update(calendar)
        .set({ lastSyncedAt: ctx.now, lastError: null })
        .where(eq(calendar.id, cal.id));
    }
    // A calendar Google says isn't there (deleted, or no longer shared) is that one calendar while
    // the account has others: Settings names it (its lastError), and the account is judged by the
    // others, so a failing one recovers, whichever calendar was read first. With none but such
    // calendars selected, the account is failing: told at once, as before.
    if (gone.length === selected.length) troubles.push(...gone);
    await recordCalendarHealth(ctx, acct, troubles, progressed, paused);
  }
  return result;
}
