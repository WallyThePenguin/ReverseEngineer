// Two things on your calendar at once. A meeting on a big task's time block moves the block,
// however far out it is (Jarvis's own initiative, so it stops while Jarvis is paused). Two of your
// meetings at once are told, when it's near enough to act on: plain arithmetic, like a heads-up,
// so it goes on while Jarvis is paused. The same meeting seen through two of your accounts isn't
// a clash, and two repeating meetings that clash every week are told once.
import { createHash } from "node:crypto";
import { formatDateTime, localParts } from "@hearth/core";
import { calendar, calendarEvent, entity } from "@hearth/db";
import { getSetting, type ReadContext, type ReflexDef, type ReflexOutcome } from "@hearth/kernel";
import { and, eq, gt, lt, ne } from "drizzle-orm";
import { inSelectedCalendar } from "./calendars.ts";
import { type EventView, loadEvent, NOT_MEETINGS, toEventView, whenText } from "./store.ts";

/** How far ahead a clash is told: one two months out is told when it's two weeks away. */
export const WARN_DAYS = 14;
const DAY_MS = 24 * 3600_000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type EntityRow = typeof entity.$inferSelect;
type EventRow = typeof calendarEvent.$inferSelect;
type Own = { icalUid: string | null; series: string | null };

/** An event still ahead on a calendar you sync, and what's on at the same time on those. */
async function clashes(ctx: ReadContext, eventId: string) {
  const ev = await loadEvent(ctx.db, eventId);
  if (!ev || ev.status === "cancelled" || ev.allDay || !ev.busy || ev.selfResponse === "declined")
    return null;
  // Over already (Jarvis catching up after a while down): not news.
  if (ev.endsAt <= ctx.now) return null;
  // On a calendar you still sync: one you've turned off keeps its rows, which go stale.
  const [own] = await ctx.db
    .select({ icalUid: calendarEvent.icalUid, series: calendarEvent.recurringEventId })
    .from(calendarEvent)
    .innerJoin(calendar, inSelectedCalendar)
    .where(eq(calendarEvent.entityId, ev.id));
  if (!own) return null;
  const rows = await ctx.db
    .select({ e: entity, r: calendarEvent })
    .from(calendarEvent)
    .innerJoin(entity, eq(entity.id, calendarEvent.entityId))
    .innerJoin(calendar, inSelectedCalendar)
    .where(
      and(
        ne(calendarEvent.entityId, ev.id),
        ne(calendarEvent.status, "cancelled"),
        eq(calendarEvent.allDay, false),
        eq(calendarEvent.busy, true),
        lt(calendarEvent.startsAt, ev.endsAt),
        gt(calendarEvent.endsAt, ev.startsAt),
        // The time they overlap is still ahead too.
        gt(calendarEvent.endsAt, ctx.now),
      ),
    );
  const others = rows.filter(
    ({ r }) =>
      r.selfResponse !== "declined" &&
      // The same meeting, on two of your accounts' calendars.
      !(own.icalUid && r.icalUid === own.icalUid),
  );
  return { ev, own, others };
}

/**
 * The notice for one clash. Keyed per occurrence, the same across two accounts' copies, so a
 * one-off that moves onto another week's meeting is told again. Two repeating meetings are keyed
 * by the weekday and time they clash: one notice for every week, and a new one when an exception
 * clashes some other time.
 */
function notice(ev: EventView, own: Own, e: EntityRow, r: EventRow, tz: string): ReflexOutcome {
  const start = new Date(Math.max(ev.startsAt.getTime(), r.startsAt.getTime()));
  const { weekday, hour, minute } = localParts(start, tz);
  const series = own.series && r.recurringEventId;
  const sides = series
    ? [own.icalUid ?? own.series, r.icalUid ?? r.recurringEventId]
    : [
        `${own.icalUid ?? ev.id}@${ev.startsAt.toISOString()}`,
        `${r.icalUid ?? e.id}@${r.startsAt.toISOString()}`,
      ];
  const key = [...sides.sort(), ...(series ? [`${weekday} ${hour}:${minute}`] : [])].join(":");
  return {
    kind: "tell",
    notification: {
      kind: "calendar.conflict",
      title: `"${ev.title}" overlaps "${e.title}"`,
      // Each ends on a time, "a.m." or "p.m.": a sentence's end already. Two series are told
      // when they meet, not "every Monday": one week's meeting may only have been moved there.
      body: series
        ? `Both repeat, and overlap on ${WEEKDAYS[weekday]} ${formatDateTime(start, tz)}`
        : `${whenText(ev, tz)} and ${whenText(toEventView(e, r), tz)}`,
      entityId: ev.id,
      urgency: "normal",
      // Hashed: Exchange's UIDs are long, and a key past inbox.notify's limit isn't told at all.
      dedupeKey: `conflict:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`,
    },
  };
}

/** Clashes near enough to tell now; one further out books a check for two weeks before. */
async function notices(ctx: ReadContext, eventId: string): Promise<ReflexOutcome[]> {
  const c = await clashes(ctx, eventId);
  if (!c) return [];
  const { ev, own } = c;
  const rules = await getSetting(ctx.db, "owner.dayRules");
  const near = new Date(ev.startsAt.getTime() - WARN_DAYS * DAY_MS);
  const out: ReflexOutcome[] = [];
  let later = false;
  for (const { e, r } of c.others) {
    // A focus block moves instead (conflicts, below); two blocks are Hearth's to sort out.
    if (r.taskId || ev.taskId) continue;
    // Only meetings overlap: not where you work, or time marked out of office.
    if (NOT_MEETINGS.includes(ev.kind) || NOT_MEETINGS.includes(r.kind)) continue;
    if (near > ctx.now) {
      later = true;
      continue;
    }
    out.push(notice(ev, own, e, r, rules.timeZone));
  }
  if (later)
    out.push({
      kind: "check_later",
      key: `near:${ev.id}`,
      at: near,
      payload: { eventId: ev.id, startsAt: ev.startsAt.toISOString() },
    });
  return out;
}

export const overlaps: ReflexDef = {
  name: "calendar.overlaps",
  description: "When two of your meetings land at the same time, you hear about it.",
  mode: "always",
  on: ["calendar.event_changed"],
  async run(event, ctx) {
    if (!event.entityId || event.payload.change === "cancelled") return [];
    return notices(ctx, event.entityId);
  },
  async onCheck(payload, ctx) {
    // Two weeks out now. Moved since: its new time has a check of its own.
    const ev = await loadEvent(ctx.db, String(payload.eventId));
    if (!ev || ev.startsAt.toISOString() !== payload.startsAt) return [];
    return notices(ctx, ev.id);
  },
};

export const conflicts: ReflexDef = {
  name: "calendar.conflicts",
  description: "When a meeting lands on a big task's time block, the block moves.",
  mode: "proactive",
  on: ["calendar.event_changed"],
  async run(event, ctx) {
    if (!event.entityId || event.payload.change === "cancelled") return [];
    const c = await clashes(ctx, event.entityId);
    if (!c) return [];
    const out: ReflexOutcome[] = [];
    for (const { r } of c.others) {
      // A meeting and a focus block: plan the task again around the meeting.
      const block =
        r.taskId && !c.ev.taskId ? r.taskId : !r.taskId && c.ev.taskId ? c.ev.taskId : null;
      if (block)
        out.push({
          kind: "check_later",
          key: `block:${block}`,
          at: new Date(event.at.getTime() + 60_000),
          payload: { taskId: block },
        });
    }
    return out;
  },
  async onCheck(payload) {
    return [{ kind: "act", action: "calendar.block_task", input: { taskId: payload.taskId } }];
  },
};
