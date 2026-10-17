// The same meeting can reach Hearth more than once: on a calendar two of your accounts both see,
// or as an invitation to two of your addresses. Every copy has the meeting's iCalUID, and each
// time of a repeating meeting its own start, so calendar.events lists a meeting at a time once.

import { calendarEvent, type DbOrTx, entity } from "@hearth/db";
import { and, eq, isNull } from "drizzle-orm";

/** Your answer on a copy, best first: the copy you said yes to is the one shown. */
const ANSWER: Record<string, number> = { accepted: 0, tentative: 1, needsAction: 2, declined: 3 };

export interface Copy {
  e: { id: string };
  r: {
    icalUid: string | null;
    googleId: string;
    startsAt: Date;
    selfResponse: string | null;
    selfOrganizer: boolean;
    status: string;
  };
  /** The account the calendar is, when it's one of your own. */
  own: string | null;
  /** Whether new events go to this calendar, which is yours even when no account is it. */
  writeDefault: boolean;
}

/**
 * Lowest is the copy to show. A cancelled copy only when every copy is. Then one on a calendar of
 * your own: on one shared with you, Google's "you" is its owner. Among yours, the one you organize,
 * so Jarvis can move or cancel it; a meeting Hearth makes doesn't list you as a guest, so there no
 * answer means yes. Then your best answer.
 */
export function rankOf(x: Copy): number {
  const yours = x.own !== null || x.writeDefault;
  const organizing = yours && x.r.selfOrganizer;
  const answer =
    organizing && x.r.selfResponse === null ? 0 : (ANSWER[x.r.selfResponse ?? ""] ?? 2);
  return (
    (x.r.status === "cancelled" ? 1000 : 0) + (yours ? 0 : 100) + (organizing ? 0 : 10) + answer
  );
}

const keyOf = (r: Copy["r"]) => `${r.icalUid ?? r.googleId}@${r.startsAt.toISOString()}`;

/**
 * Each meeting at a time once, in the order given, with every copy of it and the one to show. Ties
 * go to the lowest id, so the same copy is shown on every read whatever order the rows came in.
 */
export function oneEach<T extends Copy>(rows: readonly T[]): { shown: T; copies: T[] }[] {
  const groups = new Map<string, { shown: T; copies: T[] }>();
  for (const x of rows) {
    const group = groups.get(keyOf(x.r));
    if (!group) groups.set(keyOf(x.r), { shown: x, copies: [x] });
    else {
      group.copies.push(x);
      const [a, b] = [rankOf(x), rankOf(group.shown)];
      if (a < b || (a === b && x.e.id < group.shown.e.id)) group.shown = x;
    }
  }
  return [...groups.values()];
}

/**
 * The ids of every live copy of an event, itself first: the same iCalUID at the same start. One
 * with no iCalUID is only itself. A prep or notes on any copy belong to the meeting.
 */
export async function copiesOf(db: DbOrTx, id: string): Promise<string[]> {
  const [ev] = await db
    .select({ icalUid: calendarEvent.icalUid, startsAt: calendarEvent.startsAt })
    .from(calendarEvent)
    .where(eq(calendarEvent.entityId, id));
  if (!ev?.icalUid) return [id];
  const rows = await db
    .select({ id: calendarEvent.entityId })
    .from(calendarEvent)
    .innerJoin(entity, eq(entity.id, calendarEvent.entityId))
    .where(
      and(
        eq(calendarEvent.icalUid, ev.icalUid),
        eq(calendarEvent.startsAt, ev.startsAt),
        isNull(entity.deletedAt),
      ),
    );
  return [id, ...rows.map((r) => r.id).filter((x) => x !== id)];
}
