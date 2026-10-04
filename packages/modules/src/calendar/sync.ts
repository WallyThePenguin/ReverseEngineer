// Calendar sync: your calendars and their events from a week back to two months ahead, pulled
// from Google every few minutes. Changes become events Jarvis can react to. Calls are paced like
// Gmail's, against Calendar's own quota; when Google asks Hearth to slow down, the account waits
// for the next round instead of failing, and one event that won't save is skipped (D55).
import { startOfLocalDay } from "@hearth/core";
import { calendar, calendarEvent, entity, googleAccount } from "@hearth/db";
import { type ActionContext, getSetting, savepoint } from "@hearth/kernel";
import { and, arrayContains, asc, eq, gt, isNull, lt, ne, notInArray } from "drizzle-orm";
import { CalendarApi, type GEvent } from "../google/calendar-api.ts";
import { cleanDeep } from "../google/clean.ts";
import { GOOGLE_SERVICE, GoogleApiError, type GoogleClient, SCOPES } from "../google/client.ts";
import { id } from "../shared.ts";
import { syncCalendarList } from "./calendars.ts";
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
    try {
      await syncCalendarList(ctx, api, acct.email);
    } catch (err) {
      if (slowDown(err)) result.paused.push(acct.email);
      else result.failed.push(`${acct.email}: ${messageOf(err)}`);
      continue;
    }
    const cals = await ctx.tx
      .select()
      .from(calendar)
      .where(and(eq(calendar.account, acct.email), eq(calendar.selected, true)));
    for (const cal of cals) {
      let items: Awaited<ReturnType<CalendarApi["events"]>>;
      try {
        items = await api.events(acct.email, cal.googleId, from, to);
      } catch (err) {
        // A slowdown holds every calendar of the account: the rest wait for the next round.
        if (slowDown(err)) {
          result.paused.push(acct.email);
          break;
        }
        const message = messageOf(err);
        result.failed.push(`${cal.title}: ${message}`);
        await ctx.tx.update(calendar).set({ lastError: message }).where(eq(calendar.id, cal.id));
        continue;
      }
      result.calendars++;
      const seen: string[] = [];
      for (const g of items) {
        const m = mapEvent(cal.id, cleanDeep(g), rules.timeZone);
        if (!m) continue;
        // Seen even if it won't save, so it isn't taken for deleted at Google.
        seen.push(g.id);
        result.events++;
        let saved: Awaited<ReturnType<typeof saveEvent>>;
        try {
          saved = await savepoint(ctx, async (sp) => saveEvent(sp, m, await blockOf(sp, g)));
        } catch {
          result.skipped++;
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
  }
  if (result.failed.length) {
    ctx.emit({ kind: "calendar.sync_failed", payload: { errors: result.failed } });
  }
  return result;
}
