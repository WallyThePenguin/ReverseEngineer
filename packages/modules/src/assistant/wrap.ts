// The evening's "Your day" card: it opens the day's journal, and says what tomorrow starts with.
// Plain facts from Hearth's own tables, so it arrives even when Jarvis is paused.
import { addLocalDays, atLocal, formatTime } from "@hearth/core";
import { calendar, calendarEvent, type DbOrTx, entity, task } from "@hearth/db";
import { and, asc, count, eq, gte, isNull, lt, ne, notInArray, or } from "drizzle-orm";

/** Meetings named on the card; the rest are counted. */
const FIRST_MEETINGS = 3;

/** A title as one plain line. */
const plain = (title: string) =>
  title
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);

/** The day after `date`: its first meetings and how many tasks fall due, as plain lines. */
export async function tomorrowAtAGlance(db: DbOrTx, date: string, tz: string): Promise<string> {
  const day = addLocalDays(date, 1);
  const from = atLocal(day, 0, tz);
  const to = atLocal(addLocalDays(day, 1), 0, tz);
  const meetings = await db
    .select({
      id: entity.id,
      title: entity.title,
      startsAt: calendarEvent.startsAt,
      icalUid: calendarEvent.icalUid,
    })
    .from(calendarEvent)
    .innerJoin(entity, eq(entity.id, calendarEvent.entityId))
    .innerJoin(
      calendar,
      and(eq(calendar.id, calendarEvent.calendarId), eq(calendar.selected, true)),
    )
    .where(
      and(
        isNull(entity.deletedAt),
        ne(calendarEvent.status, "cancelled"),
        eq(calendarEvent.allDay, false),
        isNull(calendarEvent.taskId),
        or(isNull(calendarEvent.selfResponse), ne(calendarEvent.selfResponse, "declined")),
        gte(calendarEvent.startsAt, from),
        lt(calendarEvent.startsAt, to),
      ),
    )
    .orderBy(asc(calendarEvent.startsAt));
  const [due] = await db
    .select({ n: count() })
    .from(task)
    .innerJoin(entity, eq(entity.id, task.entityId))
    .where(
      and(
        isNull(entity.deletedAt),
        notInArray(task.status, ["completed", "canceled"]),
        gte(task.dueAt, from),
        lt(task.dueAt, to),
      ),
    );
  // The same invitation on two of your calendars is one meeting.
  const seen = new Set<string>();
  const once = meetings.filter((m) => {
    const key = `${m.icalUid ?? m.id}:${m.startsAt.toISOString()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const named = once
    .slice(0, FIRST_MEETINGS)
    .map((m) => `${formatTime(m.startsAt, tz)} ${plain(m.title)}`);
  const more = once.length - named.length;
  const lines = [
    named.length
      ? `Tomorrow: ${named.join(", ")}${more ? `, and ${more} more` : ""}`
      : "Nothing on your calendar tomorrow.",
  ];
  const n = due?.n ?? 0;
  if (n) lines.push(`${n} task${n === 1 ? "" : "s"} due tomorrow.`);
  return lines.join("\n");
}
