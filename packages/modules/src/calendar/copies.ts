// The same meeting can reach Hearth more than once: on a calendar two of your accounts both see,
// or as an invitation to two of your addresses. Every copy has the meeting's iCalUID, and each
// time of a repeating meeting its own start, so calendar.events lists a meeting at a time once.

/** Your answer on a copy, best first: the copy you said yes to is the one shown. */
const ANSWER: Record<string, number> = { accepted: 0, tentative: 1, needsAction: 2, declined: 3 };

interface Copy {
  r: { icalUid: string | null; googleId: string; startsAt: Date; selfResponse: string | null };
  /** The account the calendar is, when it's one of your own. */
  own: string | null;
}

/**
 * Each meeting at a time once, in the order given, with every copy of it: the one shown is on a
 * calendar of your own if any is (on one shared with you, Google's "you" is its owner), then the
 * one with your best answer.
 */
export function oneEach<T extends Copy>(rows: readonly T[]): { shown: T; copies: T[] }[] {
  const rank = (x: T) => (x.own === null ? 10 : 0) + (ANSWER[x.r.selfResponse ?? ""] ?? 2);
  const groups = new Map<string, { shown: T; copies: T[] }>();
  for (const x of rows) {
    const key = `${x.r.icalUid ?? x.r.googleId}@${x.r.startsAt.toISOString()}`;
    const group = groups.get(key);
    if (!group) groups.set(key, { shown: x, copies: [x] });
    else {
      group.copies.push(x);
      if (rank(x) < rank(group.shown)) group.shown = x;
    }
  }
  return [...groups.values()];
}
