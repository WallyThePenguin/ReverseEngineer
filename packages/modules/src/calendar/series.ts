// Editing a repeating meeting at Google, for all events or this and following ones, gives every
// occurrence from then on a new id: the old ones vanish and new ones appear. Taken as it comes,
// each future meeting is cancelled and added again, leaving its prep and notes on the old row and
// telling its overlaps once more. Matched up by when they were instead, a new occurrence takes
// over the row of the one it replaces, and the change is only what moved.
import { calendarEvent, type DbOrTx } from "@hearth/db";
import { and, eq, gt, inArray, isNotNull, lt, ne, notInArray } from "drizzle-orm";
import type { Mapped } from "./store.ts";

/**
 * How far an occurrence can move and still be taken for the one it replaces: to another weekday,
 * or across midnight, but not as far as the next week's.
 */
const REACH_MS = 3 * 24 * 3600_000;

/** Google's "this and following" splits off a series named the old id, "_R" and when it starts. */
const seriesOf = (id: string) => id.replace(/(_R\d{8}(T\d{6}Z?)?)+$/, "");

/**
 * Which row each newly listed occurrence of a repeating meeting takes over (Google id to entity
 * id): one of the same series, at most three days apart, that Google no longer lists. The
 * closest pairs are matched first, one to one, so two a day each keep their own.
 */
export async function seriesTakeovers(
  db: DbOrTx,
  calendarId: string,
  listed: Mapped[],
  window: { from: Date; to: Date },
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
  const bySeries = new Map<string, typeof gone>();
  for (const g of gone) {
    const key = seriesOf(g.series!);
    bySeries.set(key, [...(bySeries.get(key) ?? []), g]);
  }
  const pairs: { googleId: string; id: string; apart: number }[] = [];
  for (const m of repeating) {
    if (known.has(m.googleId)) continue;
    for (const g of bySeries.get(seriesOf(m.recurringEventId!)) ?? []) {
      const apart = Math.abs(g.startsAt.getTime() - m.startsAt.getTime());
      if (apart <= REACH_MS) pairs.push({ googleId: m.googleId, id: g.id, apart });
    }
  }
  pairs.sort(
    (a, b) => a.apart - b.apart || a.googleId.localeCompare(b.googleId) || a.id.localeCompare(b.id),
  );
  const taken = new Set<string>();
  for (const p of pairs) {
    if (out.has(p.googleId) || taken.has(p.id)) continue;
    out.set(p.googleId, p.id);
    taken.add(p.id);
  }
  return out;
}
