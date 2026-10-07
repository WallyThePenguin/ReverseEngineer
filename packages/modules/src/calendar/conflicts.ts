// Overlap notices: two of your meetings at once, told once, when it's near enough to act on. The
// same meeting seen through two of your accounts isn't a clash, and two repeating meetings that
// clash are told once, not every week. A meeting on a big task's time block moves the block
// instead, however far out it is.
import { calendar, calendarEvent, entity } from "@hearth/db";
import { getSetting, type ReadContext, type ReflexDef, type ReflexOutcome } from "@hearth/kernel";
import { and, eq, gt, lt, ne } from "drizzle-orm";
import { inSelectedCalendar } from "./calendars.ts";
import { loadEvent, NOT_MEETINGS, toEventView, whenText } from "./store.ts";

/** How far ahead a clash is told: one two months out is told when it's two weeks away. */
export const WARN_DAYS = 14;
const DAY_MS = 24 * 3600_000;

/** What an event clashes with: notices for meetings, and moves for time blocks (`at`: when). */
async function overlaps(ctx: ReadContext, eventId: string, at: Date | null) {
  const ev = await loadEvent(ctx.db, eventId);
  if (!ev || ev.status === "cancelled" || ev.allDay || !ev.busy || ev.selfResponse === "declined")
    return [];
  // Over already (Jarvis catching up after a while down): not news.
  if (ev.endsAt <= ctx.now) return [];
  // Only what's on calendars you sync: a colleague's calendar you've turned off isn't yours.
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
      ),
    );
  const [own] = await ctx.db
    .select({ icalUid: calendarEvent.icalUid })
    .from(calendarEvent)
    .where(eq(calendarEvent.entityId, ev.id));
  const rules = await getSetting(ctx.db, "owner.dayRules");
  const near = new Date(ev.startsAt.getTime() - WARN_DAYS * DAY_MS);
  const out: ReflexOutcome[] = [];
  let later = false;
  for (const { e, r } of rows) {
    if (r.selfResponse === "declined") continue;
    // The same meeting, on two of your accounts' calendars.
    if (own?.icalUid && r.icalUid === own.icalUid) continue;
    // A meeting and a focus block: plan the task again around the meeting.
    const block = r.taskId && !ev.taskId ? r.taskId : !r.taskId && ev.taskId ? ev.taskId : null;
    if (block) {
      if (at)
        out.push({
          kind: "check_later",
          key: `block:${block}`,
          at: new Date(at.getTime() + 60_000),
          payload: { taskId: block },
        });
      continue;
    }
    // Only meetings overlap: not where you work, or time marked out of office.
    if (r.taskId || NOT_MEETINGS.includes(ev.kind) || NOT_MEETINGS.includes(r.kind)) continue;
    if (near > ctx.now) {
      later = true;
      continue;
    }
    // Keyed by Google's iCalUID where there is one: every instance of a repeating meeting has
    // the same, as does its copy on another account, so two repeating meetings are one notice.
    const [a, b] = [own?.icalUid ?? ev.id, r.icalUid ?? e.id].sort();
    out.push({
      kind: "tell",
      notification: {
        kind: "calendar.conflict",
        title: `"${ev.title}" overlaps "${e.title}"`,
        body: `${whenText(ev, rules.timeZone)} and ${whenText(toEventView(e, r), rules.timeZone)}.`,
        entityId: ev.id,
        urgency: "normal",
        dedupeKey: `conflict:${a}:${b}`,
      },
    });
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

export const conflicts: ReflexDef = {
  name: "calendar.conflicts",
  description:
    "When an event lands on top of another, you hear about it; if it lands on a task's time block, the block moves.",
  mode: "proactive",
  on: ["calendar.event_changed"],
  async run(event, ctx) {
    if (!event.entityId || event.payload.change === "cancelled") return [];
    return overlaps(ctx, event.entityId, event.at);
  },
  async onCheck(payload, ctx) {
    if (payload.taskId)
      return [{ kind: "act", action: "calendar.block_task", input: { taskId: payload.taskId } }];
    // Two weeks out now. Moved since: its new time has a check of its own.
    const ev = await loadEvent(ctx.db, String(payload.eventId));
    if (!ev || ev.startsAt.toISOString() !== payload.startsAt) return [];
    return overlaps(ctx, ev.id, null);
  },
};
