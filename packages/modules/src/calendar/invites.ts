// A new invitation becomes one card: accept it with one tap. Whether you're free is plain
// calendar arithmetic, so no model turn is spent; the answer goes out only once you say yes.
import { PRINCIPAL, startOfLocalDay } from "@hearth/core";
import { approval, calendar, calendarEvent, type DbOrTx, entity, googleAccount } from "@hearth/db";
import { getSetting, type ReflexDef } from "@hearth/kernel";
import { and, asc, count, eq, gt, gte, isNull, lt, ne, or } from "drizzle-orm";
import { personFor } from "../people/store.ts";
import { inSelectedCalendar } from "./calendars.ts";
import { type EventView, loadEvent } from "./store.ts";

/** Invitation cards in one day: a newly connected calendar can hold dozens of old ones. */
export const INVITE_CARDS = 15;
/** Times of a repeating meeting checked for clashes: accepting answers them all. */
const SERIES_CHECKED = 5;

/**
 * The primary calendar of any account of yours, even when another of yours syncs it. On a calendar
 * someone else shared with you, Google's "you" is its owner: accepting there would answer as them.
 */
async function onOwnCalendar(db: DbOrTx, ev: EventView): Promise<boolean> {
  const [own] = await db
    .select({ id: calendar.id })
    .from(calendar)
    .innerJoin(googleAccount, eq(googleAccount.email, calendar.googleId))
    .where(eq(calendar.id, ev.calendarId))
    .limit(1);
  return Boolean(own);
}

/** A title as one plain line, so it can't pass for anything else on the card. */
const plain = (title: string) =>
  title
    .replace(/[\p{Cc}\p{Cf}"]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

interface Time {
  id: string;
  startsAt: Date;
  endsAt: Date;
  icalUid: string | null;
}

/** The times the answer covers: this one, or a series' next few you haven't answered. */
function timesAnswered(db: DbOrTx, ev: EventView, now: Date): Promise<Time[]> {
  return db
    .select({
      id: calendarEvent.entityId,
      startsAt: calendarEvent.startsAt,
      endsAt: calendarEvent.endsAt,
      icalUid: calendarEvent.icalUid,
    })
    .from(calendarEvent)
    .where(
      ev.recurringEventId
        ? and(
            eq(calendarEvent.calendarId, ev.calendarId),
            eq(calendarEvent.recurringEventId, ev.recurringEventId),
            eq(calendarEvent.selfResponse, "needsAction"),
            ne(calendarEvent.status, "cancelled"),
            gt(calendarEvent.startsAt, now),
          )
        : eq(calendarEvent.entityId, ev.id),
    )
    .orderBy(asc(calendarEvent.startsAt))
    .limit(SERIES_CHECKED);
}

/**
 * What else you have then: events you haven't declined that block the time (a whole day, for an
 * all-day invitation), leaving out this meeting's own copies on your other calendars.
 */
async function overlapping(db: DbOrTx, t: Time): Promise<string[]> {
  const rows = await db
    .select({ title: entity.title, response: calendarEvent.selfResponse })
    .from(calendarEvent)
    .innerJoin(entity, eq(entity.id, calendarEvent.entityId))
    .innerJoin(calendar, inSelectedCalendar)
    .where(
      and(
        isNull(entity.deletedAt),
        ne(calendarEvent.entityId, t.id),
        ne(calendarEvent.status, "cancelled"),
        eq(calendarEvent.busy, true),
        lt(calendarEvent.startsAt, t.endsAt),
        gt(calendarEvent.endsAt, t.startsAt),
        t.icalUid
          ? or(isNull(calendarEvent.icalUid), ne(calendarEvent.icalUid, t.icalUid))
          : undefined,
      ),
    );
  return rows.filter((r) => r.response !== "declined").map((r) => plain(r.title));
}

/** Whether you're free, said plainly: for a series, over the times the answer covers. */
async function availability(db: DbOrTx, times: Time[], repeats: boolean): Promise<string> {
  const clashes: string[][] = [];
  for (const t of times) clashes.push(await overlapping(db, t));
  if (!repeats) {
    const others = clashes[0] ?? [];
    if (others.length === 0) return "You're free then.";
    if (others.length === 1) return `It overlaps "${others[0]}".`;
    return `It overlaps "${others[0]}" and ${others.length - 1} more.`;
  }
  const busy = clashes.filter((c) => c.length > 0);
  const n = times.length;
  if (busy.length === 0)
    return `It repeats; you're free ${n === 1 ? "the next time" : `the next ${n} times`}.`;
  return `It repeats; ${busy.length} of the next ${n} times overlap, first "${busy[0]![0]}".`;
}

export const newInvite: ReflexDef = {
  name: "calendar.new_invite",
  description: `A new invitation on your own calendar from someone you know becomes one card saying who it's from and whether you're free; one tap accepts it (up to ${INVITE_CARDS} a day).`,
  mode: "proactive",
  on: ["calendar.event_changed"],
  async run(event, ctx) {
    if (event.payload.change !== "added" || !event.entityId) return [];
    const ev = await loadEvent(ctx.db, event.entityId);
    if (!ev || ev.selfOrganizer || ev.selfResponse !== "needsAction" || !ev.organizer) return [];
    if (ev.status === "cancelled" || ev.startsAt <= ctx.now) return [];
    if (!(await onOwnCalendar(ctx.db, ev))) return [];
    // Someone you've written to or met with: anyone can put an invitation on your calendar.
    if (!(await personFor(ctx.db, ev.organizer))) return [];
    const times = await timesAnswered(ctx.db, ev, ctx.now);
    // A repeating meeting arrives as many times: one card, on the first, answers them all.
    if (times[0]?.id !== ev.id) return [];
    const { timeZone } = await getSetting(ctx.db, "owner.dayRules");
    const [today] = await ctx.db
      .select({ n: count() })
      .from(approval)
      .where(
        and(
          eq(approval.action, "calendar.respond"),
          eq(approval.requestedBy, PRINCIPAL.jarvis),
          gte(approval.createdAt, startOfLocalDay(ctx.now, timeZone)),
        ),
      );
    if ((today?.n ?? 0) >= INVITE_CARDS) return [];
    const repeats = Boolean(ev.recurringEventId);
    // Who it's from, by address: a name is whatever the sender typed.
    const why = `From ${plain(ev.organizer)}. ${await availability(ctx.db, times, repeats)}`;
    return [
      {
        kind: "act",
        action: "calendar.respond",
        input: { id: ev.id, response: "accepted", ...(repeats ? { scope: "all" } : {}) },
        ask: why,
      },
    ];
  },
};
