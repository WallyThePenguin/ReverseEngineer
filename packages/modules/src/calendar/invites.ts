// A new invitation from someone you know or a colleague: when you're free, Jarvis accepts it and
// tells you, with Undo (D71); otherwise it becomes one card, accepted with one tap. Whether you're
// free is plain calendar arithmetic, so no model turn is spent.
import { PRINCIPAL, startOfLocalDay } from "@hearth/core";
import {
  approval,
  calendar,
  calendarEvent,
  type DbOrTx,
  entity,
  googleAccount,
  notification,
  personEmail,
} from "@hearth/db";
import { getSetting, type ReflexDef, type ReflexOutcome } from "@hearth/kernel";
import { and, asc, count, eq, gt, gte, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { companyDomain, isRoleAddress } from "../people/domains.ts";
import { personFor } from "../people/store.ts";
import { inSelectedCalendar, isOwnCalendar } from "./calendars.ts";
import { type EventView, loadEvent } from "./store.ts";

/** Invitation cards in one day: a newly connected calendar can hold dozens of old ones. */
export const INVITE_CARDS = 15;
/** Invitations Jarvis accepts on its own in one day (D71); past it, they're cards. */
export const AUTO_ACCEPTS = 10;
/** A repeating meeting is accepted on its own only if every time this far ahead is free (D71). */
export const SERIES_DAYS = 28;
/** An invitation made at Google longer ago than this isn't new: the owner left it be. */
export const NEW_INVITE_MS = 86_400_000;
/** The FYI's kind when Jarvis accepted an invitation on its own. */
export const ACCEPTED = "calendar.accepted";
/** Times of a repeating meeting a card checks for clashes: accepting answers them all. */
const SERIES_CHECKED = 5;

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

/**
 * The times the answer covers: this one, or a series' next few you haven't answered (with `until`,
 * every one up to then).
 */
function timesAnswered(db: DbOrTx, ev: EventView, now: Date, until?: Date): Promise<Time[]> {
  const q = db
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
            until ? lte(calendarEvent.startsAt, until) : undefined,
          )
        : eq(calendarEvent.entityId, ev.id),
    )
    .orderBy(asc(calendarEvent.startsAt));
  return until ? q : q.limit(SERIES_CHECKED);
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

/** Someone at your own company: their address's company domain is one of your accounts'. */
export async function colleague(db: DbOrTx, address: string): Promise<boolean> {
  const domain = companyDomain(address);
  if (!domain) return false;
  const yours = await db.select({ email: googleAccount.email }).from(googleAccount);
  return yours.some((a) => companyDomain(a.email) === domain);
}

/**
 * Whom Jarvis may accept from without asking (D71): a person you know (not one you put in the
 * trash) or a colleague, never a role address like events@ or noreply@.
 */
async function vouched(db: DbOrTx, address: string): Promise<boolean> {
  if (isRoleAddress(address)) return false;
  const [known] = await db
    .select({ id: personEmail.personId })
    .from(personEmail)
    .innerJoin(entity, eq(entity.id, personEmail.personId))
    .where(and(eq(personEmail.address, address), isNull(entity.deletedAt)));
  return Boolean(known) || colleague(db, address);
}

/**
 * Why Jarvis can't accept this invitation itself, or null when it may (D71): an invitation to you
 * on your own calendar, not answered yet, from someone vouched for, and nothing of yours overlaps
 * it (for a repeating meeting, any time in the next 4 weeks it would answer).
 */
export async function cannotAccept(db: DbOrTx, ev: EventView, now: Date): Promise<string | null> {
  if (ev.selfOrganizer || !ev.organizer) return "This isn't an invitation to you.";
  if (ev.selfResponse !== "needsAction") return "This invitation is answered already.";
  if (ev.status === "cancelled" || ev.startsAt <= now) return "This meeting is cancelled or over.";
  if (!(await isOwnCalendar(db, ev.calendarId)))
    return "This invitation is on a calendar someone shared with you.";
  if (!(await vouched(db, ev.organizer)))
    return "It's from someone the owner doesn't know, or a role address.";
  const until = new Date(Math.max(now.getTime() + SERIES_DAYS * 86_400_000, ev.startsAt.getTime()));
  for (const t of await timesAnswered(db, ev, now, until)) {
    const others = await overlapping(db, t);
    if (others.length > 0) return `It overlaps "${others[0]}".`;
  }
  return null;
}

/** Invitations Jarvis accepted on its own today, by the Undo its FYIs carry (only it writes one). */
export async function acceptedToday(db: DbOrTx, now: Date): Promise<number> {
  const { timeZone } = await getSetting(db, "owner.dayRules");
  const [row] = await db
    .select({ n: count() })
    .from(notification)
    .where(
      and(
        sql`${notification.undo}->>'kind' = 'unaccept'`,
        gte(notification.createdAt, startOfLocalDay(now, timeZone)),
      ),
    );
  return row?.n ?? 0;
}

export const newInvite: ReflexDef = {
  name: "calendar.new_invite",
  description: `A new invitation on your own calendar from someone you know or a colleague: when you're free, Jarvis accepts it and tells you, with Undo (up to ${AUTO_ACCEPTS} a day); otherwise it becomes one card saying whether you're free, and one tap accepts it (up to ${INVITE_CARDS} a day).`,
  mode: "proactive",
  on: ["calendar.event_changed"],
  async run(event, ctx) {
    if (event.payload.change !== "added" || !event.entityId) return [];
    const ev = await loadEvent(ctx.db, event.entityId);
    if (!ev || ev.selfOrganizer || ev.selfResponse !== "needsAction" || !ev.organizer) return [];
    if (ev.status === "cancelled" || ev.startsAt <= ctx.now) return [];
    if (!(await isOwnCalendar(ctx.db, ev.calendarId))) return [];
    // Someone you've written to or met with, or a colleague: anyone can put an invitation on
    // your calendar.
    const known =
      Boolean(await personFor(ctx.db, ev.organizer)) || (await colleague(ctx.db, ev.organizer));
    if (!known) return [];
    const times = await timesAnswered(ctx.db, ev, ctx.now);
    // A repeating meeting arrives as many times: one answer, on the first, covers them all.
    if (times[0]?.id !== ev.id) return [];
    const card = await inviteCard(ctx.db, ev, ev.organizer, times, ctx.now);
    // Only a new one: a calendar's first sync, or a reconnect, brings invitations the owner left
    // unanswered as "added" too. Those are cards at most.
    const made = Date.parse(String(event.payload.created ?? ""));
    const isNew = ctx.now.getTime() - made < NEW_INVITE_MS;
    // The handler checks all of it again as it runs. If it can't accept after all (the meeting
    // changed, Google failed), the card goes out instead; past the day's count, it's the card.
    if (
      isNew &&
      !(await cannotAccept(ctx.db, ev, ctx.now)) &&
      (await acceptedToday(ctx.db, ctx.now)) < AUTO_ACCEPTS
    )
      return [
        {
          kind: "act",
          action: "calendar.accept_invite",
          input: { id: ev.id },
          fallback: card ? [card] : [],
        },
      ];
    return card ? [card] : [];
  },
};

/** The invitation's card, saying who it's from and whether you're free; none past the day's. */
async function inviteCard(
  db: DbOrTx,
  ev: EventView,
  organizer: string,
  times: Time[],
  now: Date,
): Promise<ReflexOutcome | null> {
  const { timeZone } = await getSetting(db, "owner.dayRules");
  const [today] = await db
    .select({ n: count() })
    .from(approval)
    .where(
      and(
        eq(approval.action, "calendar.respond"),
        eq(approval.requestedBy, PRINCIPAL.jarvis),
        gte(approval.createdAt, startOfLocalDay(now, timeZone)),
      ),
    );
  if ((today?.n ?? 0) >= INVITE_CARDS) return null;
  const repeats = Boolean(ev.recurringEventId);
  // Who it's from, by address: a name is whatever the sender typed.
  const why = `From ${plain(organizer)}. ${await availability(db, times, repeats)}`;
  return {
    kind: "act",
    action: "calendar.respond",
    input: { id: ev.id, response: "accepted", ...(repeats ? { scope: "all" } : {}) },
    ask: why,
  };
}
