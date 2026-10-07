// A heads-up ten minutes before each real meeting, with the top of its prep and the join link.
// Plain arithmetic, so it never spends a model turn and keeps coming while Jarvis is paused; it
// rings through quiet hours and the day's cap only because the meeting is about to start.
import { calendar, calendarEvent, type DbOrTx, googleAccount } from "@hearth/db";
import { getSetting, type ReflexDef, type ReflexOutcome } from "@hearth/kernel";
import { and, eq, isNotNull, ne, or } from "drizzle-orm";
import { preview } from "../shared.ts";
import { eventsToPrep, prepsFor, worthPrep } from "./prep.ts";
import { type EventView, loadEvent } from "./store.ts";

export const HEADS_UP_MINUTES = 10;
/** No calendar sync tried for this long (four missed rounds): the PC slept or Hearth was off. */
export const STALE_CALENDAR_MS = 20 * 60_000;
/** How soon a heads-up waiting for that first sync looks again. */
const RECHECK_MS = 60_000;
/** It waits only until then: closer to the start, it rings from what Hearth has. */
const LAST_CALL_MS = 3 * 60_000;
/** Routines whose firing looks ahead for meetings already on the calendar, and how far. */
const LOOK_AHEAD_HOURS: Record<string, number> = {
  "calendar.prep": 48,
  // Every 25 minutes in the day: picks up anything the morning missed.
  "jarvis.heartbeat": 1,
};

const remind = (ev: EventView, now: Date): ReflexOutcome => ({
  kind: "check_later",
  key: ev.id,
  at: new Date(Math.max(now.getTime(), ev.startsAt.getTime() - HEADS_UP_MINUTES * 60_000)),
  payload: { eventId: ev.id, startsAt: ev.startsAt.toISOString() },
});

/** A title as one plain line. */
const plain = (title: string) =>
  title
    .replace(/[\p{Cc}\p{Cf}"]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);

/**
 * The meeting as one key across your accounts (the same invitation on two calendars is one
 * meeting), on a calendar you still see that's one of your own: an account's own calendar or the
 * one new events go to, not a family or team calendar shared with you, nor one you've turned off
 * since. Only one you set up or said yes or maybe to: an invitation nobody answered, a stranger's
 * included, mustn't ring through the night.
 */
async function yours(db: DbOrTx, ev: EventView): Promise<string | null> {
  if (!ev.selfOrganizer && ev.selfResponse !== "accepted" && ev.selfResponse !== "tentative")
    return null;
  const [row] = await db
    .select({ icalUid: calendarEvent.icalUid })
    .from(calendarEvent)
    .innerJoin(calendar, eq(calendar.id, calendarEvent.calendarId))
    .leftJoin(googleAccount, eq(googleAccount.email, calendar.googleId))
    .where(
      and(
        eq(calendarEvent.entityId, ev.id),
        eq(calendar.selected, true),
        or(isNotNull(googleAccount.email), eq(calendar.writeDefault, true)),
      ),
    )
    .limit(1);
  return row ? (row.icalUid ?? ev.id) : null;
}

/**
 * Whether the calendar this event came from hasn't been synced since before the PC slept: the
 * meeting may have moved or been cancelled overnight, and the first sync after waking would say.
 * Not an account that needs connecting again: it isn't synced at all until then.
 */
async function asleepSince(db: DbOrTx, eventId: string, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ at: googleAccount.calendarAttemptedAt })
    .from(calendarEvent)
    .innerJoin(calendar, eq(calendar.id, calendarEvent.calendarId))
    .innerJoin(
      googleAccount,
      and(eq(googleAccount.email, calendar.account), ne(googleAccount.status, "revoked")),
    )
    .where(eq(calendarEvent.entityId, eventId))
    .limit(1);
  return !!row?.at && now.getTime() - row.at.getTime() >= STALE_CALENDAR_MS;
}

/** prepFacts's lines: when, where, who, and pointers with ids meant for Jarvis. */
const FACT =
  /^- (When|Event id|Where|Video|Guests|About|Open task|Last time|Linked|Has a description|Last meeting with them)\b/;
const HAS_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * What a prep says first, in its own words: none of the facts block (title, time, people, ids,
 * a past meeting's indented summary). The plain facts written when Jarvis couldn't write the prep
 * have none, so they give nothing.
 */
export function gist(body: string): string {
  const line = body
    .split("\n")
    .find(
      (raw) =>
        raw.trim() &&
        !/^\s/.test(raw) &&
        !raw.startsWith("#") &&
        !FACT.test(raw) &&
        !HAS_ID.test(raw),
    );
  return line ? preview(line.trim().replace(/^[-*]\s+/, ""), 200) : "";
}

export const meetingSoon: ReflexDef = {
  name: "calendar.meeting_soon",
  description: `${HEADS_UP_MINUTES} minutes before a meeting, a heads-up with its prep and join link, even while Jarvis is paused.`,
  mode: "always",
  on: ["calendar.event_changed", "clock.fired"],
  // An event Jarvis put on your calendar is still yours to be reminded of.
  includeJarvisEvents: true,
  async run(event, ctx) {
    if (event.kind === "clock.fired") {
      const hours = LOOK_AHEAD_HOURS[String(event.payload.routine)];
      if (event.payload.kind !== "routine" || !hours) return [];
      return (await eventsToPrep(ctx, hours)).map((ev) => remind(ev, ctx.now));
    }
    if (!event.entityId || event.payload.change === "cancelled") return [];
    const ev = await loadEvent(ctx.db, event.entityId);
    if (!ev || ev.startsAt <= ctx.now) return [];
    if (!worthPrep(ev, await getSetting(ctx.db, "calendar.prepMinMinutes"))) return [];
    return [remind(ev, ctx.now)];
  },
  async onCheck(payload, ctx) {
    const ev = await loadEvent(ctx.db, String(payload.eventId));
    // Moved since (its new time has a check of its own), cancelled, declined, or already begun.
    if (!ev || ev.startsAt.toISOString() !== payload.startsAt || ev.startsAt <= ctx.now) return [];
    if (!worthPrep(ev, await getSetting(ctx.db, "calendar.prepMinMinutes"))) return [];
    const meeting = await yours(ctx.db, ev);
    if (!meeting) return [];
    // Came due while the PC slept: wait for the first sync after waking, which comes within a
    // minute or two, but not past the last few minutes: then it rings from Hearth's copy.
    if (
      ev.startsAt.getTime() - ctx.now.getTime() > LAST_CALL_MS &&
      (await asleepSince(ctx.db, ev.id, ctx.now))
    )
      return [{ ...remind(ev, ctx.now), at: new Date(ctx.now.getTime() + RECHECK_MS) }];
    const prep = (await prepsFor(ctx.db, [ev.id])).get(ev.id);
    const minutes = Math.max(1, Math.round((ev.startsAt.getTime() - ctx.now.getTime()) / 60_000));
    const said = prep ? gist(prep.body) : "";
    // Where first: a phone shows only the start of the body.
    const lines = [
      ...(ev.meetUrl ? [`Join: ${ev.meetUrl}`] : ev.location ? [`Where: ${ev.location}`] : []),
      ...(said ? [said] : []),
    ];
    return [
      {
        kind: "tell",
        notification: {
          kind: "calendar.meeting_soon",
          title: `"${plain(ev.title)}" in ${minutes} min`,
          ...(lines.length ? { body: lines.join("\n") } : {}),
          entityId: ev.id,
          urgency: "interrupt",
          deadline: ev.startsAt,
          dedupeKey: `meeting_soon:${meeting}:${ev.startsAt.toISOString()}`,
        },
      },
    ];
  },
};
