// Your calendars, per account. Each connected account has its own row for every calendar it sees,
// so a calendar two accounts share (a holiday calendar, a colleague's) is in both, and it's synced
// through one of them at a time. You choose which calendars Hearth syncs, and which one it puts
// new events on (D61).
import { calendar, calendarEvent, entity, googleAccount } from "@hearth/db";
import { type ActionContext, ActionError, defineAction, newId, savepoint } from "@hearth/kernel";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import type { CalendarApi } from "../google/calendar-api.ts";
import { cleanDeep } from "../google/clean.ts";
import { GOOGLE_SERVICE, type GoogleClient } from "../google/client.ts";

export type CalendarRow = typeof calendar.$inferSelect;

/** Joins an event to its calendar, only if you sync that calendar. */
export const inSelectedCalendar = and(
  eq(calendar.id, calendarEvent.calendarId),
  eq(calendar.selected, true),
);

/** Deletes calendars and their events (the records too, not just the rows). */
export async function dropCalendars(ctx: ActionContext, ids: string[]) {
  if (ids.length === 0) return;
  const events = ctx.tx
    .select({ id: calendarEvent.entityId })
    .from(calendarEvent)
    .where(inArray(calendarEvent.calendarId, ids));
  await ctx.tx.delete(entity).where(inArray(entity.id, events));
  await ctx.tx.delete(calendar).where(inArray(calendar.id, ids));
}

/** Brings one account's calendar list up to date. */
export async function syncCalendarList(ctx: ActionContext, api: CalendarApi, account: string) {
  const list = cleanDeep(await api.calendars(account)).filter((c) => !c.deleted);
  const known = await ctx.tx.select().from(calendar).where(eq(calendar.account, account));
  for (const c of list) {
    const values = {
      title: c.summaryOverride ?? c.summary,
      color: c.backgroundColor ?? null,
      timeZone: c.timeZone ?? null,
      isPrimary: Boolean(c.primary),
      canWrite: c.accessRole === "owner" || c.accessRole === "writer",
    };
    // One calendar that won't save is left out on its own; before, it undid the whole sync (6.2).
    await savepoint(ctx, async (sp) => {
      const row = known.find((k) => k.googleId === c.id);
      if (row) {
        await sp.tx.update(calendar).set(values).where(eq(calendar.id, row.id));
        return;
      }
      // New calendars you own are synced; ones shared with you (holidays, a colleague's) start
      // off, and you can turn them on in Settings. One another account already syncs stays off,
      // so its events aren't there twice.
      const [elsewhere] = await sp.tx
        .select({ id: calendar.id })
        .from(calendar)
        .where(and(eq(calendar.googleId, c.id), eq(calendar.selected, true)));
      await sp.tx.insert(calendar).values({
        id: newId(),
        account,
        googleId: c.id,
        ...values,
        selected: c.accessRole === "owner" && !elsewhere,
      });
    }).catch(() => {});
  }
  const gone = known.filter((k) => !list.some((c) => c.id === k.googleId)).map((k) => k.id);
  await dropCalendars(ctx, gone);
}

/**
 * The calendar Hearth writes to: the one asked for (by Hearth's id, or Google's), else the one
 * chosen in Settings, else the primary calendar of the account connected first.
 */
export async function writableCalendar(ctx: ActionContext, calendarId?: string) {
  const rows = await ctx.tx
    .select({ c: calendar })
    .from(calendar)
    .innerJoin(googleAccount, eq(googleAccount.email, calendar.account))
    .where(eq(calendar.canWrite, true))
    .orderBy(
      desc(calendar.selected),
      asc(googleAccount.connectedAt),
      asc(calendar.account),
      desc(calendar.isPrimary),
    );
  const all = rows.map((r) => r.c);
  const cal = calendarId
    ? (all.find((r) => r.id === calendarId) ?? all.find((r) => r.googleId === calendarId))
    : (all.find((r) => r.writeDefault) ??
      all.find((r) => r.isPrimary && r.googleId === r.account) ??
      all.find((r) => r.isPrimary) ??
      all[0]);
  if (!cal)
    throw new ActionError(
      calendarId ? "not_found" : "unavailable",
      calendarId
        ? "That calendar isn't connected, or Hearth can't write to it."
        : "No Google Calendar is connected. Connect one in Settings.",
    );
  return cal;
}

export const calendarSetupActions = [
  defineAction({
    name: "calendar.calendars",
    description:
      "Connected Google accounts and their calendars: which ones Hearth syncs, and which one new events go to (writeDefault).",
    input: z.object({}),
    risk: "read",
    async handler(_i, ctx) {
      const google = ctx.service<GoogleClient>(GOOGLE_SERVICE);
      const accounts = await ctx.tx
        .select({
          email: googleAccount.email,
          scopes: googleAccount.scopes,
          status: googleAccount.status,
          lastError: googleAccount.lastError,
          connectedAt: googleAccount.connectedAt,
        })
        .from(googleAccount)
        .orderBy(asc(googleAccount.connectedAt));
      const calendars = await ctx.tx
        .select()
        .from(calendar)
        .orderBy(asc(calendar.account), desc(calendar.isPrimary), asc(calendar.title));
      const writeTo = await writableCalendar(ctx).catch(() => null);
      return {
        configured: google.configured,
        accounts,
        calendars: calendars.map((c) => ({ ...c, writeDefault: c.id === writeTo?.id })),
      };
    },
  }),
  defineAction({
    name: "calendar.choose",
    description: "Turn syncing on or off for one calendar.",
    input: z.object({ id: z.string().min(1), selected: z.boolean() }),
    risk: "internal",
    callers: ["owner"],
    async handler(i, ctx) {
      const [row] = await ctx.tx.select().from(calendar).where(eq(calendar.id, i.id));
      if (!row) throw new ActionError("not_found", "That calendar isn't connected.");
      if (i.selected) {
        // A calendar two accounts share is synced through one of them, or it shows twice.
        const [other] = await ctx.tx
          .select({ account: calendar.account })
          .from(calendar)
          .where(
            and(
              eq(calendar.googleId, row.googleId),
              ne(calendar.id, row.id),
              eq(calendar.selected, true),
            ),
          );
        if (other)
          throw new ActionError(
            "conflict",
            `"${row.title}" already syncs through ${other.account}. Turn it off there first.`,
          );
      }
      await ctx.tx
        .update(calendar)
        .set({ selected: i.selected, ...(i.selected ? {} : { writeDefault: false }) })
        .where(eq(calendar.id, i.id));
      return { ok: true };
    },
  }),
  defineAction({
    name: "calendar.set_default",
    description: "Choose the calendar Hearth puts new events and time blocks on.",
    input: z.object({ id: z.string().min(1) }),
    risk: "internal",
    callers: ["owner"],
    async handler(i, ctx) {
      const [row] = await ctx.tx.select().from(calendar).where(eq(calendar.id, i.id));
      if (!row?.canWrite)
        throw new ActionError(
          "not_found",
          "That calendar isn't connected, or Hearth can't write to it.",
        );
      await ctx.tx
        .update(calendar)
        .set({ writeDefault: false })
        .where(eq(calendar.writeDefault, true));
      // What Hearth writes there should show in Hearth too.
      await ctx.tx
        .update(calendar)
        .set({ writeDefault: true, selected: true })
        .where(eq(calendar.id, row.id));
      // Synced through this account from now on, if another account shares it.
      await ctx.tx
        .update(calendar)
        .set({ selected: false })
        .where(and(eq(calendar.googleId, row.googleId), ne(calendar.id, row.id)));
      return { id: row.id };
    },
  }),
];
