// Writing your calendar. Your own events (no guests) change directly; anything guests would see
// is a separate action that waits for your yes (PLAN.md section 5.5).
import type { DbOrTx } from "@hearth/db";
import { type ActionContext, ActionError, defineAction, getSetting } from "@hearth/kernel";
import { z } from "zod";
import { CalendarApi, type GEvent, type SendUpdates } from "../google/calendar-api.ts";
import { cleanDeep } from "../google/clean.ts";
import { GOOGLE_SERVICE, type GoogleClient } from "../google/client.ts";
import { id } from "../shared.ts";
import { writableCalendar } from "./calendars.ts";
import {
  type EventView,
  emitChange,
  guests,
  loadEvent,
  mapEvent,
  saveEvent,
  whenText,
} from "./store.ts";

const when = z.union([
  z.string().datetime({ offset: true }),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date like 2026-10-02 for all-day events"),
]);
const fields = {
  title: z.string().trim().min(1).max(500),
  start: when.describe("ISO date-time with offset, or a date for an all-day event"),
  end: when.describe("ISO date-time with offset, or the day after the last day for all-day"),
  description: z.string().max(20_000).optional(),
  location: z.string().max(500).optional(),
};
const emails = z.array(z.string().email()).min(1).max(50);

export function api(ctx: ActionContext) {
  return new CalendarApi(ctx.service<GoogleClient>(GOOGLE_SERVICE), ctx.tx);
}

function time(v: string): { date: string } | { dateTime: string } {
  return v.length === 10 ? { date: v } : { dateTime: v };
}

function checkOrder(start?: string, end?: string) {
  if (start && end && new Date(end) <= new Date(start))
    throw new ActionError("invalid_input", "The end has to be after the start.");
}

export async function save(
  ctx: ActionContext,
  calendarId: string,
  g: GEvent,
  taskId?: string | null,
) {
  const rules = await getSetting(ctx.tx, "owner.dayRules");
  const m = mapEvent(calendarId, cleanDeep(g), rules.timeZone);
  if (!m) throw new ActionError("failed", "Google returned an event Hearth can't read.");
  const { id: eid, change } = await saveEvent(ctx, m, taskId === undefined ? {} : { taskId });
  emitChange(ctx, eid, change, m);
  return (await loadEvent(ctx.tx, eid)) as EventView;
}

/** Creates an event on your calendar. Used by the actions below and by time-blocking. */
export async function insertEvent(
  ctx: ActionContext,
  input: {
    title: string;
    start: string;
    end: string;
    description?: string;
    location?: string;
    calendarId?: string;
    attendees?: string[];
    taskId?: string;
  },
): Promise<EventView> {
  checkOrder(input.start, input.end);
  const cal = await writableCalendar(ctx, input.calendarId);
  const body: Partial<GEvent> = {
    summary: input.title,
    start: time(input.start),
    end: time(input.end),
    ...(input.description ? { description: input.description } : {}),
    ...(input.location ? { location: input.location } : {}),
    ...(input.attendees ? { attendees: input.attendees.map((email) => ({ email })) } : {}),
    ...(input.taskId ? { extendedProperties: { private: { hearthTask: input.taskId } } } : {}),
  };
  const send: SendUpdates = input.attendees?.length ? "all" : "none";
  const g = await api(ctx).insertOnce(cal.account, cal.googleId, body, send);
  return save(ctx, cal.id, g, input.taskId ?? null);
}

async function editable(ctx: ActionContext, eventId: string, shared: boolean) {
  const ev = await loadEvent(ctx.tx, eventId);
  if (!ev || ev.status === "cancelled") throw new ActionError("not_found", "Event not found");
  const cal = await writableCalendar(ctx, ev.calendarId);
  const hasGuests = guests(ev).length > 0;
  if (hasGuests && !shared)
    throw new ActionError(
      "forbidden",
      "This event has guests, so changing it notifies them. Use calendar_update_meeting or calendar_cancel_meeting.",
    );
  if (hasGuests && !ev.selfOrganizer)
    throw new ActionError(
      "forbidden",
      "Someone else organizes this meeting. You can answer it with calendar_respond.",
    );
  return { ev, cal };
}

export async function patchEvent(
  ctx: ActionContext,
  eventId: string,
  patch: { title?: string; start?: string; end?: string; description?: string; location?: string },
  shared = false,
): Promise<EventView> {
  checkOrder(patch.start, patch.end);
  const { ev, cal } = await editable(ctx, eventId, shared);
  const body: Partial<GEvent> = {
    ...(patch.title !== undefined ? { summary: patch.title } : {}),
    ...(patch.start ? { start: time(patch.start) } : {}),
    ...(patch.end ? { end: time(patch.end) } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.location !== undefined ? { location: patch.location } : {}),
  };
  const g = await api(ctx).patch(
    cal.account,
    cal.googleId,
    ev.googleId,
    body,
    shared ? "all" : "none",
  );
  return save(ctx, cal.id, g);
}

export async function removeEvent(ctx: ActionContext, eventId: string, shared = false) {
  const { ev, cal } = await editable(ctx, eventId, shared);
  await api(ctx).remove(cal.account, cal.googleId, ev.googleId, shared ? "all" : "none");
  await save(ctx, cal.id, {
    id: ev.googleId,
    status: "cancelled",
    summary: ev.title,
    start: { dateTime: ev.startsAt.toISOString() },
    end: { dateTime: ev.endsAt.toISOString() },
  });
  return { cancelled: ev.id };
}

const describeTimes = (i: { title: string; start: string; end: string }) =>
  `"${i.title}" ${i.start} to ${i.end}`;

/** A meeting on one line, as an approval shows it: its title can't pass for anything else. */
export async function meetingText(db: DbOrTx, ev: EventView): Promise<string> {
  const { timeZone } = await getSetting(db, "owner.dayRules");
  const title = ev.title
    .replace(/[\p{Cc}\p{Cf}"]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `"${title}", ${whenText(ev, timeZone)}`;
}

export const calendarWriteActions = [
  defineAction({
    name: "calendar.create_event",
    description:
      "Put an event on the owner's own calendar, with no guests (a reminder, a block of time, a personal appointment).",
    input: z.object({ ...fields, calendarId: z.string().optional() }),
    risk: "self_external",
    summarize: (i) => `Add ${describeTimes(i)} to your calendar`,
    handler: (i, ctx) => insertEvent(ctx, i),
  }),
  defineAction({
    name: "calendar.update_event",
    description:
      "Move or change one of the owner's own events (no guests). For meetings with guests use calendar_update_meeting.",
    input: z.object({
      id,
      title: fields.title.optional(),
      start: when.optional(),
      end: when.optional(),
      description: fields.description,
      location: fields.location,
    }),
    risk: "self_external",
    handler: ({ id: eid, ...patch }, ctx) => patchEvent(ctx, eid, patch),
  }),
  defineAction({
    name: "calendar.delete_event",
    description: "Remove one of the owner's own events (no guests) from their calendar.",
    input: z.object({ id }),
    risk: "self_external",
    handler: (i, ctx) => removeEvent(ctx, i.id),
  }),
  defineAction({
    name: "calendar.schedule_meeting",
    description: "Create a meeting and send invitations to guests by email.",
    input: z.object({ ...fields, attendees: emails, calendarId: z.string().optional() }),
    risk: "outward",
    summarize: (i) => `Invite ${i.attendees.join(", ")} to ${describeTimes(i)}`,
    handler: (i, ctx) => insertEvent(ctx, i),
  }),
  defineAction({
    name: "calendar.update_meeting",
    description: "Change a meeting the owner organizes; guests get an update.",
    input: z.object({
      id,
      title: fields.title.optional(),
      start: when.optional(),
      end: when.optional(),
      description: fields.description,
      location: fields.location,
    }),
    risk: "outward",
    summarize: (i) =>
      `Update a meeting${i.start ? ` to start ${i.start}` : ""}${i.title ? ` as "${i.title}"` : ""}, telling its guests`,
    handler: ({ id: eid, ...patch }, ctx) => patchEvent(ctx, eid, patch, true),
  }),
  defineAction({
    name: "calendar.cancel_meeting",
    description: "Cancel a meeting the owner organizes; guests are told.",
    input: z.object({ id }),
    risk: "outward",
    summarize: () => "Cancel a meeting and tell its guests",
    handler: (i, ctx) => removeEvent(ctx, i.id, true),
  }),
];
