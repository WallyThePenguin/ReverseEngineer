// Calendar events as Hearth keeps them: Google's event mapped onto an entity plus its row, and
// the shape the app and Jarvis read.
import { atLocal, formatDateTime, formatTime, localDate } from "@hearth/core";
import {
  type Attendee,
  calendarEvent,
  type DbOrTx,
  type EventStatus,
  entity,
  link,
} from "@hearth/db";
import {
  type ActionContext,
  createEntity,
  type EntityRow,
  getSetting,
  updateEntity,
} from "@hearth/kernel";
import { and, eq, isNull } from "drizzle-orm";
import type { GEvent } from "../google/calendar-api.ts";
import { addressKey } from "../mail/mine.ts";
import { ensurePerson, linkPerson, personFor, yourAccounts } from "../people/store.ts";

export type EventRow = typeof calendarEvent.$inferSelect;

/**
 * Entries Google adds by itself to say where you work that day or whose birthday it is. They
 * aren't plans, so the brief, the journal and the evening card leave them out.
 */
export const NOT_PLANS = ["workingLocation", "birthday"];
/** Nor are they, or time marked out of office, meetings: no prep, heads-up or overlap notice. */
export const NOT_MEETINGS = [...NOT_PLANS, "outOfOffice"];

export interface EventView {
  id: string;
  title: string;
  description: string;
  calendarId: string;
  googleId: string;
  status: EventStatus;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  location: string | null;
  meetUrl: string | null;
  htmlLink: string | null;
  busy: boolean;
  organizer: string | null;
  selfOrganizer: boolean;
  selfResponse: string | null;
  attendees: Attendee[];
  /** The series it's one time of, for a repeating event. */
  recurringEventId: string | null;
  /** Google's eventType: "default", "workingLocation", "outOfOffice"... */
  kind: string;
  taskId: string | null;
  /** Its prep packet's record, when calendar.events lists it. */
  prepId?: string;
  /**
   * On a calendar of your own (calendar.events and calendar.get say), so its invitation is yours
   * to answer. On one someone shared with you, "you" (self) is its owner.
   */
  ownCalendar?: boolean;
}

export function toEventView(e: EntityRow, r: EventRow): EventView {
  return {
    id: e.id,
    title: e.title,
    description: e.body ?? "",
    calendarId: r.calendarId,
    googleId: r.googleId,
    status: r.status,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    allDay: r.allDay,
    location: r.location,
    meetUrl: r.meetUrl,
    htmlLink: r.htmlLink,
    busy: r.busy,
    organizer: r.organizer,
    selfOrganizer: r.selfOrganizer,
    selfResponse: r.selfResponse,
    attendees: r.attendees,
    recurringEventId: r.recurringEventId,
    kind: r.kind,
    taskId: r.taskId,
  };
}

/** "Thu 2026-10-01, 10 a.m. to 11 a.m." or "2026-10-01, all day". */
export function whenText(v: Pick<EventView, "startsAt" | "endsAt" | "allDay">, tz: string): string {
  if (v.allDay) {
    const last = localDate(new Date(v.endsAt.getTime() - 1), tz);
    const first = localDate(v.startsAt, tz);
    return first === last ? `${first}, all day` : `${first} to ${last}, all day`;
  }
  return `${formatDateTime(v.startsAt, tz)} to ${formatTime(v.endsAt, tz)}`;
}

/** Other people on an event: everyone but you and meeting rooms. */
export function guests(v: Pick<EventView, "attendees">): Attendee[] {
  return v.attendees.filter((a) => !a.self);
}

export type Mapped = Omit<EventRow, "entityId" | "taskId" | "peopleLinked"> & {
  title: string;
  body: string;
};

export function mapEvent(calendarId: string, g: GEvent, tz: string): Mapped | null {
  if (!g.start || !g.end) return null;
  const allDay = Boolean(g.start.date);
  const startsAt = allDay
    ? atLocal(g.start.date!, 0, tz)
    : new Date(g.start.dateTime ?? g.start.date ?? "");
  const endsAt = allDay ? atLocal(g.end.date!, 0, tz) : new Date(g.end.dateTime ?? "");
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) return null;
  const attendees: Attendee[] = (g.attendees ?? [])
    .filter((a) => !a.resource)
    .map((a) => ({
      email: a.email.toLowerCase(),
      ...(a.displayName ? { name: a.displayName } : {}),
      ...(a.responseStatus ? { response: a.responseStatus } : {}),
      ...(a.self ? { self: true } : {}),
      ...(a.organizer ? { organizer: true } : {}),
    }));
  const me = attendees.find((a) => a.self);
  return {
    title: g.summary ?? "(no title)",
    body: g.description ?? "",
    calendarId,
    googleId: g.id,
    etag: g.etag ?? null,
    status: g.status ?? "confirmed",
    startsAt,
    endsAt,
    allDay,
    location: g.location ?? null,
    meetUrl: g.hangoutLink ?? null,
    htmlLink: g.htmlLink ?? null,
    busy: g.transparency !== "transparent",
    organizer: g.organizer?.email?.toLowerCase() ?? null,
    selfOrganizer: g.organizer?.self ?? attendees.length === 0,
    selfResponse: me?.response ?? null,
    attendees,
    recurringEventId: g.recurringEventId ?? null,
    icalUid: g.iCalUID ?? null,
    kind: g.eventType ?? "default",
  };
}

export async function findEvent(db: DbOrTx, calendarId: string, googleId: string) {
  const [row] = await db
    .select({ e: entity, r: calendarEvent })
    .from(calendarEvent)
    .innerJoin(entity, eq(entity.id, calendarEvent.entityId))
    .where(and(eq(calendarEvent.calendarId, calendarId), eq(calendarEvent.googleId, googleId)));
  return row ?? null;
}

async function eventRow(db: DbOrTx, id: string) {
  const [row] = await db
    .select({ e: entity, r: calendarEvent })
    .from(calendarEvent)
    .innerJoin(entity, eq(entity.id, calendarEvent.entityId))
    .where(eq(calendarEvent.entityId, id));
  return row ?? null;
}

export async function loadEvent(db: DbOrTx, id: string): Promise<EventView | null> {
  const row = await eventRow(db, id);
  return row && !row.e.deletedAt ? toEventView(row.e, row.r) : null;
}

/** Meetings bigger than this are announcements; their guests don't all become people. */
const MAX_GUESTS = 20;

/**
 * Links an event to the people on it. A meeting you organized or accepted makes its guests
 * people (like mail you send); any other only links the people you already know.
 */
async function linkGuests(ctx: ActionContext, id: string, m: Mapped): Promise<void> {
  if (m.status === "cancelled") return;
  const guests = m.attendees.filter((a) => !a.self);
  if (guests.length === 0) return;
  // You aren't a guest you know: your other accounts are on the invitation too, at times.
  const mine = await yourAccounts(ctx.tx);
  const list = guests.filter((a) => !mine.has(addressKey(a.email))).slice(0, MAX_GUESTS);
  const yours =
    m.attendees.length <= MAX_GUESTS + 1 && (m.selfOrganizer || m.selfResponse === "accepted");
  for (const g of list) {
    const personId = yours
      ? await ensurePerson(ctx, { address: g.email, ...(g.name ? { name: g.name } : {}) })
      : await personFor(ctx.tx, g.email);
    if (personId) await linkPerson(ctx, id, personId);
  }
}

/** A prep packet's name: the meeting and its day. */
export const prepTitle = (title: string, startsAt: Date, timeZone: string) =>
  `Prep: ${title} (${localDate(startsAt, timeZone)})`;

/**
 * A meeting moved or renamed: its prep packet's name says the new day, and a "When" line in it
 * the new time. What it says about the people and last time still holds.
 */
async function followPrep(ctx: ActionContext, eventId: string, m: Mapped): Promise<void> {
  const preps = await ctx.tx
    .select({ id: entity.id, title: entity.title, body: entity.body })
    .from(link)
    .innerJoin(entity, eq(entity.id, link.fromId))
    .where(and(eq(link.toId, eventId), eq(entity.type, "prep"), isNull(entity.deletedAt)));
  if (!preps.length) return;
  const { timeZone } = await getSetting(ctx.tx, "owner.dayRules");
  for (const p of preps) {
    const title = prepTitle(m.title, m.startsAt, timeZone);
    const was = p.body ?? "";
    const body = was.replace(/^- When: .*$/m, `- When: ${whenText(m, timeZone)}`);
    if (title !== p.title || body !== was) await updateEntity(ctx, p.id, { title, body });
  }
}

export type Change = "added" | "updated" | "cancelled" | null;

/**
 * Saves Google's version of an event. Returns what changed, for the event log. `replaces`: the
 * row a repeating meeting's occurrence takes over when Google gave it a new id (series.ts).
 */
export async function saveEvent(
  ctx: ActionContext,
  m: Mapped,
  extra: { taskId?: string | null; replaces?: string } = {},
): Promise<{ id: string; change: Change }> {
  const found = await findEvent(ctx.tx, m.calendarId, m.googleId);
  const existing = found ?? (extra.replaces ? await eventRow(ctx.tx, extra.replaces) : null);
  const { title, body, ...fields } = m;
  if (!existing) {
    if (m.status === "cancelled") return { id: "", change: null };
    const row = await createEntity(ctx, { type: "event", title, body });
    await ctx.tx
      .insert(calendarEvent)
      .values({ entityId: row.id, ...fields, taskId: extra.taskId ?? null, peopleLinked: true });
    await linkGuests(ctx, row.id, m);
    return { id: row.id, change: "added" };
  }
  const { e, r } = existing;
  // Unchanged, unless it's from before Hearth kept UIDs, linked guests to people or kept kinds.
  if (
    r.etag &&
    r.etag === m.etag &&
    !e.deletedAt &&
    (r.icalUid || !m.icalUid) &&
    r.peopleLinked &&
    r.kind === m.kind
  )
    return { id: e.id, change: null };
  const moved =
    r.startsAt.getTime() !== m.startsAt.getTime() || r.endsAt.getTime() !== m.endsAt.getTime();
  // The organizer changed the series and asks you again: new to you, as an invitation is.
  const askedAgain = !found && r.selfResponse !== "needsAction" && m.selfResponse === "needsAction";
  const change: Change =
    m.status === "cancelled"
      ? r.status === "cancelled"
        ? null
        : "cancelled"
      : askedAgain
        ? "added"
        : moved || r.status !== m.status || e.title !== title
          ? "updated"
          : null;
  if (!e.deletedAt) await updateEntity(ctx, e.id, { title, body });
  await ctx.tx
    .update(calendarEvent)
    .set({
      ...fields,
      peopleLinked: true,
      ...(extra.taskId !== undefined ? { taskId: extra.taskId } : {}),
    })
    .where(eq(calendarEvent.entityId, e.id));
  if (!e.deletedAt) await linkGuests(ctx, e.id, m);
  if (!e.deletedAt && change === "updated") await followPrep(ctx, e.id, m);
  return { id: e.id, change };
}

export function emitChange(
  ctx: ActionContext,
  id: string,
  change: Change,
  m: Pick<Mapped, "title" | "startsAt" | "endsAt" | "status">,
) {
  if (!change) return;
  ctx.emit({
    kind: "calendar.event_changed",
    entityId: id,
    payload: {
      change,
      title: m.title,
      startsAt: m.startsAt.toISOString(),
      endsAt: m.endsAt.toISOString(),
    },
  });
}
