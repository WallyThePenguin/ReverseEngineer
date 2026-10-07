// Editing a repeating meeting at Google, for all events or this and following ones, gives every
// occurrence from then on a new id: the old ones vanish and new ones appear. Taken as it comes,
// each future meeting is cancelled and added again, leaving its prep and notes on the old row and
// telling its overlaps once more. Matched up by day instead, a new occurrence takes over the row
// of the one it replaces, and the change is only what moved.
import { localDate } from "@hearth/core";
import { calendarEvent, type DbOrTx } from "@hearth/db";
import { and, eq, gt, inArray, isNotNull, lt, ne, notInArray } from "drizzle-orm";
import type { Mapped } from "./store.ts";

/** Google's "this and following" splits off a series named the old id, "_R" and when it starts. */
const seriesOf = (id: string) => id.replace(/(_R\d{8}(T\d{6}Z?)?)+$/, "");

/**
 * Which row each newly listed occurrence of a repeating meeting takes over (Google id to entity
 * id): one of the same series on the same day that Google no longer lists.
 */
export async function seriesTakeovers(
  db: DbOrTx,
  calendarId: string,
  listed: Mapped[],
  window: { from: Date; to: Date },
  timeZone: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = listed.map((m) => m.googleId);
  const gone = await db
    .select({
      id: calendarEvent.entityId,
      series: calendarEvent.recurringEventId,
      startsAt: calendarEvent.startsAt,
    })
    .from(calendarEvent)
    .where(
      and(
        eq(calendarEvent.calendarId, calendarId),
        ne(calendarEvent.status, "cancelled"),
        isNotNull(calendarEvent.recurringEventId),
        gt(calendarEvent.endsAt, window.from),
        lt(calendarEvent.startsAt, window.to),
        ...(ids.length ? [notInArray(calendarEvent.googleId, ids)] : []),
      ),
    );
  if (!gone.length) return out;
  const repeating = listed.filter((m) => m.recurringEventId && m.status !== "cancelled");
  if (!repeating.length) return out;
  const known = new Set(
    (
      await db
        .select({ googleId: calendarEvent.googleId })
        .from(calendarEvent)
        .where(
          and(
            eq(calendarEvent.calendarId, calendarId),
            inArray(
              calendarEvent.googleId,
              repeating.map((m) => m.googleId),
            ),
          ),
        )
    ).map((r) => r.googleId),
  );
  const day = (d: Date) => localDate(d, timeZone);
  const taken = new Set<string>();
  for (const m of repeating) {
    if (known.has(m.googleId)) continue;
    const series = seriesOf(m.recurringEventId!);
    const old = gone.find(
      (g) =>
        !taken.has(g.id) && day(g.startsAt) === day(m.startsAt) && seriesOf(g.series!) === series,
    );
    if (!old) continue;
    taken.add(old.id);
    out.set(m.googleId, old.id);
  }
  return out;
}
