// Calendar events as Hearth keeps them: Google's event mapped onto an entity plus its row, and
// the shape the app and Jarvis read.
import { atLocal, formatDateTime, formatTime, localDate } from "@hearth/core";
import { type Attendee, calendarEvent, type DbOrTx, type EventStatus, entity } from "@hearth/db";
import { type ActionContext, createEntity, type EntityRow, updateEntity } from "@hearth/kernel";
import { and, eq } from "drizzle-orm";
import type { GEvent } from "../google/calendar-api.ts";

export type EventRow = typeof calendarEvent.$inferSelect;

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
  taskId: string | null;
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

export type Mapped = Omit<EventRow, "entityId" | "taskId"> & { title: string; body: string };

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

export async function loadEvent(db: DbOrTx, id: string): Promise<EventView | null> {
  const [row] = await db
    .select({ e: entity, r: calendarEvent })
    .from(calendarEvent)
    .innerJoin(entity, eq(entity.id, calendarEvent.entityId))
    .where(eq(calendarEvent.entityId, id));
  return row && !row.e.deletedAt ? toEventView(row.e, row.r) : null;
}

export type Change = "added" | "updated" | "cancelled" | null;

/** Saves Google's version of an event. Returns what changed, for the event log. */
export async function saveEvent(
  ctx: ActionContext,
  m: Mapped,
  extra: { taskId?: string | null } = {},
): Promise<{ id: string; change: Change }> {
  const existing = await findEvent(ctx.tx, m.calendarId, m.googleId);
  const { title, body, ...fields } = m;
  if (!existing) {
    if (m.status === "cancelled") return { id: "", change: null };
    const row = await createEntity(ctx, { type: "event", title, body });
    await ctx.tx
      .insert(calendarEvent)
      .values({ entityId: row.id, ...fields, taskId: extra.taskId ?? null });
    return { id: row.id, change: "added" };
  }
  const { e, r } = existing;
  // Unchanged, unless it's from before Hearth kept UIDs.
  if (r.etag && r.etag === m.etag && !e.deletedAt && (r.icalUid || !m.icalUid))
    return { id: e.id, change: null };
  const moved =
    r.startsAt.getTime() !== m.startsAt.getTime() || r.endsAt.getTime() !== m.endsAt.getTime();
  const change: Change =
    m.status === "cancelled"
      ? r.status === "cancelled"
        ? null
        : "cancelled"
      : moved || r.status !== m.status || e.title !== title
        ? "updated"
        : null;
  if (!e.deletedAt) await updateEntity(ctx, e.id, { title, body });
  await ctx.tx
    .update(calendarEvent)
    .set({ ...fields, ...(extra.taskId !== undefined ? { taskId: extra.taskId } : {}) })
    .where(eq(calendarEvent.entityId, e.id));
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
