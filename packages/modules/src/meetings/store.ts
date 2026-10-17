// Meetings as Hearth keeps them: your notes (the entity's body), the transcript, Jarvis's summary,
// and links to the calendar event, the people in it and the tasks that came out of it.
import {
  calendarEvent,
  type DbOrTx,
  entity,
  link,
  meeting,
  meetingSegment,
  task,
} from "@hearth/db";
import {
  type ActionContext,
  ActionError,
  addLink,
  createEntity,
  type EntityRow,
} from "@hearth/kernel";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, ne, notInArray } from "drizzle-orm";
import { copiesOf } from "../calendar/copies.ts";
import { NOT_MEETINGS } from "../calendar/store.ts";

export interface MeetingView {
  id: string;
  title: string;
  notes: string;
  /** The record's revision: pass it back to meeting.update to save over this copy only. */
  revision: number;
  startedAt: Date;
  endedAt: Date | null;
  summary: string | null;
  summarizedAt: Date | null;
  event: { id: string; title: string; startsAt: Date; endsAt: Date } | null;
  people: { id: string; name: string }[];
  tasks: { id: string; title: string; number: number; status: string }[];
  transcript: {
    id: string;
    channel: "me" | "them";
    startMs: number;
    endMs: number;
    text: string;
  }[];
}

/** The most transcript a meeting keeps. */
export const MAX_SEGMENTS = 10_000;

/** The people an event or meeting is linked to. */
export async function peopleOn(db: DbOrTx, fromId: string) {
  return db
    .select({ id: entity.id, name: entity.title })
    .from(link)
    .innerJoin(entity, eq(entity.id, link.toId))
    .where(
      and(
        eq(link.fromId, fromId),
        eq(link.kind, "participant"),
        eq(entity.type, "person"),
        isNull(entity.deletedAt),
      ),
    )
    .orderBy(asc(entity.title));
}

/** The meeting for an event, made the first time you take notes in it. */
export async function startMeeting(
  ctx: ActionContext,
  i: { eventId?: string; title?: string; peopleIds?: string[] },
): Promise<string> {
  let title = i.title ?? "Meeting";
  let startedAt = ctx.now;
  if (i.eventId) {
    // Notes started on another copy of the same meeting (an invitation to your other address).
    const [known] = await ctx.tx
      .select({ id: meeting.entityId })
      .from(meeting)
      .innerJoin(entity, eq(entity.id, meeting.entityId))
      .where(
        and(inArray(meeting.eventId, await copiesOf(ctx.tx, i.eventId)), isNull(entity.deletedAt)),
      )
      .orderBy(asc(entity.createdAt))
      .limit(1);
    if (known) return known.id;
    const [ev] = await ctx.tx
      .select({ title: entity.title, startsAt: calendarEvent.startsAt })
      .from(calendarEvent)
      .innerJoin(entity, eq(entity.id, calendarEvent.entityId))
      .where(and(eq(calendarEvent.entityId, i.eventId), isNull(entity.deletedAt)));
    if (!ev) throw new ActionError("not_found", "No such event");
    title = i.title ?? ev.title;
    // Notes taken before the meeting start count from its start.
    if (ev.startsAt < startedAt) startedAt = ev.startsAt;
  }
  // A meeting for this event you trashed earlier lets go of it, keeping its notes.
  if (i.eventId)
    await ctx.tx.update(meeting).set({ eventId: null }).where(eq(meeting.eventId, i.eventId));
  const row = await createEntity(ctx, { type: "meeting", title, body: "" });
  const inserted = await ctx.tx
    .insert(meeting)
    .values({ entityId: row.id, eventId: i.eventId ?? null, startedAt })
    .onConflictDoNothing()
    .returning({ id: meeting.entityId });
  if (inserted.length === 0)
    throw new ActionError("conflict", "Notes for this event were just started; open them again");
  // Only real people: the ids may come from Jarvis.
  const people = new Set<string>();
  if (i.peopleIds?.length) {
    const real = await ctx.tx
      .select({ id: entity.id })
      .from(entity)
      .where(
        and(inArray(entity.id, i.peopleIds), eq(entity.type, "person"), isNull(entity.deletedAt)),
      );
    for (const p of real) people.add(p.id);
  }
  if (i.eventId) {
    await addLink(ctx, { fromId: row.id, toId: i.eventId, kind: "derived_from" });
    for (const p of await peopleOn(ctx.tx, i.eventId)) people.add(p.id);
  }
  for (const p of people) await addLink(ctx, { fromId: row.id, toId: p, kind: "participant" });
  return row.id;
}

/** An event this close to starting counts as the one you're recording. */
const EARLY_MS = 10 * 60_000;
/** Notes you opened this recently, still running, are what you're recording. */
const OPEN_MS = 3 * 60 * 60_000;

/**
 * The meeting the desktop recorder records into: the one for the calendar event that's on now,
 * else notes you opened and haven't ended, else a new one. Returns how far into the meeting
 * recording starts, so transcript times line up with the meeting's own clock.
 */
export async function recordMeeting(
  ctx: ActionContext,
  i: { title?: string },
): Promise<{ id: string; title: string; offsetMs: number }> {
  const [ev] = await ctx.tx
    .select({ id: calendarEvent.entityId, title: entity.title })
    .from(calendarEvent)
    .innerJoin(entity, eq(entity.id, calendarEvent.entityId))
    .where(
      and(
        isNull(entity.deletedAt),
        eq(calendarEvent.allDay, false),
        ne(calendarEvent.status, "cancelled"),
        // A time block for a task isn't a meeting, nor is where you work or time out of office.
        isNull(calendarEvent.taskId),
        notInArray(calendarEvent.kind, NOT_MEETINGS),
        lte(calendarEvent.startsAt, new Date(ctx.now.getTime() + EARLY_MS)),
        gt(calendarEvent.endsAt, ctx.now),
      ),
    )
    .orderBy(desc(calendarEvent.startsAt))
    .limit(1);
  let id: string;
  if (ev) {
    const [known] = await ctx.tx
      .select({ endedAt: meeting.endedAt })
      .from(meeting)
      .innerJoin(entity, eq(entity.id, meeting.entityId))
      .where(and(eq(meeting.eventId, ev.id), isNull(entity.deletedAt)));
    // Already ended: a second recording is its own meeting, with the same people.
    id = known?.endedAt
      ? await startMeeting(ctx, {
          title: ev.title,
          peopleIds: (await peopleOn(ctx.tx, ev.id)).map((p) => p.id),
        })
      : await startMeeting(ctx, { eventId: ev.id });
  } else {
    const [open] = await ctx.tx
      .select({ id: meeting.entityId })
      .from(meeting)
      .innerJoin(entity, eq(entity.id, meeting.entityId))
      .where(
        and(
          isNull(entity.deletedAt),
          isNull(meeting.endedAt),
          gte(meeting.startedAt, new Date(ctx.now.getTime() - OPEN_MS)),
        ),
      )
      .orderBy(desc(meeting.startedAt))
      .limit(1);
    id = open?.id ?? (await startMeeting(ctx, { title: i.title ?? "Call" }));
  }
  const [m] = await ctx.tx
    .select({ title: entity.title, startedAt: meeting.startedAt })
    .from(meeting)
    .innerJoin(entity, eq(entity.id, meeting.entityId))
    .where(eq(meeting.entityId, id));
  return {
    id,
    title: m?.title ?? "Meeting",
    // Notes opened long before the call still start the recording near the beginning of the day.
    offsetMs: Math.min(
      86_400_000,
      Math.max(0, ctx.now.getTime() - (m?.startedAt ?? ctx.now).getTime()),
    ),
  };
}

export async function meetingView(
  db: DbOrTx,
  e: EntityRow,
  withTranscript = true,
): Promise<MeetingView | null> {
  const [m] = await db.select().from(meeting).where(eq(meeting.entityId, e.id));
  if (!m) return null;
  const [ev] = m.eventId
    ? await db
        .select({
          id: entity.id,
          title: entity.title,
          startsAt: calendarEvent.startsAt,
          endsAt: calendarEvent.endsAt,
        })
        .from(calendarEvent)
        .innerJoin(entity, eq(entity.id, calendarEvent.entityId))
        .where(and(eq(calendarEvent.entityId, m.eventId), isNull(entity.deletedAt)))
    : [];
  const tasks = await db
    .select({ id: entity.id, title: entity.title, number: task.number, status: task.status })
    .from(link)
    .innerJoin(entity, eq(entity.id, link.fromId))
    .innerJoin(task, eq(task.entityId, entity.id))
    .where(and(eq(link.toId, e.id), eq(link.kind, "derived_from"), isNull(entity.deletedAt)))
    .orderBy(asc(task.number));
  const transcript = !withTranscript
    ? []
    : await db
        .select({
          id: meetingSegment.id,
          channel: meetingSegment.channel,
          startMs: meetingSegment.startMs,
          endMs: meetingSegment.endMs,
          text: meetingSegment.text,
        })
        .from(meetingSegment)
        .where(eq(meetingSegment.meetingId, e.id))
        .orderBy(asc(meetingSegment.startMs), asc(meetingSegment.id))
        .limit(MAX_SEGMENTS);
  return {
    id: e.id,
    title: e.title,
    notes: e.body ?? "",
    revision: e.revision,
    startedAt: m.startedAt,
    endedAt: m.endedAt,
    summary: m.summary,
    summarizedAt: m.summarizedAt,
    event: ev ?? null,
    people: await peopleOn(db, e.id),
    tasks,
    transcript,
  };
}

/** "[12:04] Them: …" lines, for Jarvis. */
export function transcriptText(v: MeetingView, max = 60_000): string {
  const stamp = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const out = v.transcript
    .map((s) => `[${stamp(s.startMs)}] ${s.channel === "me" ? "Owner" : "Them"}: ${s.text}`)
    .join("\n");
  return out.length > max ? `${out.slice(0, max)}\n… (transcript cut)` : out;
}

/** Tasks already made from this meeting, by title, so publishing again doesn't repeat them. */
export async function taskTitles(db: DbOrTx, meetingId: string): Promise<Set<string>> {
  const rows = await db
    .select({ title: entity.title })
    .from(link)
    .innerJoin(entity, eq(entity.id, link.fromId))
    .where(and(eq(link.toId, meetingId), eq(link.kind, "derived_from"), eq(entity.type, "task")));
  return new Set(rows.map((r) => r.title.toLowerCase()));
}
