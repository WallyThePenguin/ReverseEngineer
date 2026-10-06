// A heads-up ten minutes before each real meeting, with the top of its prep and the join link.
// Plain arithmetic, so it never spends a model turn and keeps coming while Jarvis is paused; it
// rings through quiet hours and the day's cap only because the meeting is about to start.
import { getSetting, type ReflexDef, type ReflexOutcome } from "@hearth/kernel";
import { preview } from "../shared.ts";
import { eventsToPrep, prepsFor, worthPrep } from "./prep.ts";
import { type EventView, loadEvent } from "./store.ts";

export const HEADS_UP_MINUTES = 10;
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
    const prep = (await prepsFor(ctx.db, [ev.id])).get(ev.id);
    const minutes = Math.max(1, Math.round((ev.startsAt.getTime() - ctx.now.getTime()) / 60_000));
    const lines = [
      ...(prep?.body.trim() ? [preview(prep.body, 300)] : []),
      ...(ev.meetUrl ? [`Join: ${ev.meetUrl}`] : ev.location ? [`Where: ${ev.location}`] : []),
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
          dedupeKey: `meeting_soon:${ev.id}:${ev.startsAt.toISOString()}`,
        },
      },
    ];
  },
};
