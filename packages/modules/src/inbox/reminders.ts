// "Remind me at 3 to call Sam", "in 2 hours": a reminder rings at that minute. It's a one-shot
// schedule (kind "reminder"); when it fires, a reflex puts it in the inbox as an interrupt, even
// while Jarvis is paused. One you asked for (or Jarvis set before reading outside content) has
// its minute as its deadline, so it rings through quiet hours and the day's cap, as you asked.
// One set after reading an email or a message doesn't vouch for its own time (D54): it waits for
// quiet hours to end and for room in the day's cap, like anything else.
import { atLocal, formatDateTime, formatTime, nextLocalTime } from "@hearth/core";
import {
  ActionError,
  defineAction,
  getSetting,
  newId,
  type ReflexDef,
  upsertSchedule,
  vouchesForDeadline,
} from "@hearth/kernel";
import { z } from "zod";

/** How far ahead a reminder may be set. */
const MAX_AHEAD_MINUTES = 366 * 24 * 60;
/** Fired this late (Hearth wasn't running at the minute), it says when it was for. */
const LATE_MS = 5 * 60_000;

const CLOCK = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const DAY_CLOCK = /^(\d{4}-\d{2}-\d{2})[ T]([01]?\d|2[0-3]):([0-5]\d)$/;
const EXACT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * When a reminder is for: so many minutes from now; a time of day in your time zone (today, or
 * tomorrow once it has passed); a day and time in your time zone; or an exact time with its offset.
 * Null if `at` is none of those.
 */
export function reminderTime(
  i: { at?: string | undefined; inMinutes?: number | undefined },
  now: Date,
  timeZone: string,
): Date | null {
  if (i.inMinutes !== undefined) return new Date(now.getTime() + i.inMinutes * 60_000);
  const at = i.at?.trim() ?? "";
  const clock = CLOCK.exec(at);
  if (clock) return nextLocalTime(now, Number(clock[1]) * 60 + Number(clock[2]), timeZone);
  const day = DAY_CLOCK.exec(at);
  if (day) return atLocal(day[1]!, Number(day[2]) * 60 + Number(day[3]), timeZone);
  if (EXACT.test(at)) {
    const exact = new Date(at);
    return Number.isNaN(exact.getTime()) ? null : exact;
  }
  return null;
}

/** What to remind you of, as one plain line. */
const oneLine = (text: string) =>
  text
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

export const remindAction = defineAction({
  name: "reminder.create",
  description:
    'Remind the owner of something at a set minute: "at 3" (at "15:00"), "in 2 hours" (inMinutes 120), or a day and time. It rings then, as an interrupt in their inbox and on their phone. Use it rather than a task when they ask to be reminded at a time. Nothing goes to anyone else.',
  input: z.object({
    text: z
      .string()
      .min(1)
      .max(200)
      .describe('What to remind them of, as they\'d want to read it: "Call Sam".'),
    at: z
      .string()
      .max(40)
      .optional()
      .describe(
        'In the owner\'s time zone: "15:00" (today, or tomorrow if that has passed) or "2026-10-09 15:00". Or an exact ISO time with its offset.',
      ),
    inMinutes: z
      .number()
      .int()
      .min(1)
      .max(MAX_AHEAD_MINUTES)
      .optional()
      .describe("Or: this many minutes from now."),
  }),
  risk: "internal",
  async handler(i, ctx) {
    if ((i.at === undefined) === (i.inMinutes === undefined))
      throw new ActionError("invalid_input", "Give either at or inMinutes, not both.");
    const text = oneLine(i.text);
    if (!text) throw new ActionError("invalid_input", "Say what to remind them of.");
    const { timeZone } = await getSetting(ctx.tx, "owner.dayRules");
    const at = reminderTime(i, ctx.now, timeZone);
    if (!at)
      throw new ActionError(
        "invalid_input",
        'Give at as "15:00", "2026-10-09 15:00", or an ISO time with its offset.',
      );
    if (at <= ctx.now) throw new ActionError("invalid_input", "That time has passed.");
    if (at.getTime() - ctx.now.getTime() > MAX_AHEAD_MINUTES * 60_000)
      throw new ActionError("invalid_input", "A reminder can be at most a year ahead.");
    const id = newId();
    const vouched = vouchesForDeadline(ctx.caller);
    await upsertSchedule(
      ctx.tx,
      {
        id: `reminder:${id}`,
        kind: "reminder",
        runAt: at,
        timeZone,
        // Set after reading outside content: its clock's event carries those words, and says so.
        payload: { reminder: id, text, vouched, ...(vouched ? {} : { outside: true }) },
      },
      ctx.now,
    );
    return {
      id,
      at: at.toISOString(),
      when: formatDateTime(at, timeZone),
      ...(vouched
        ? {}
        : {
            note: "Set after reading outside content, so it waits for quiet hours and the day's cap like anything else.",
          }),
    };
  },
});

export const ringReminder: ReflexDef = {
  name: "reminder.ring",
  description:
    "When a reminder's minute comes, it rings: an interrupt in the inbox, even while Jarvis is paused.",
  mode: "always",
  on: ["clock.fired"],
  async run(event, ctx) {
    const p = event.payload;
    if (p.kind !== "reminder" || typeof p.text !== "string") return [];
    const vouched = p.vouched === true;
    const due = new Date(String(p.scheduledFor));
    const late = ctx.now.getTime() - due.getTime() > LATE_MS;
    const { timeZone } = await getSetting(ctx.db, "owner.dayRules");
    const said = [
      ...(late ? [`For ${formatTime(due, timeZone)}; Hearth wasn't running then.`] : []),
      ...(vouched
        ? []
        : ["Jarvis set this after reading an email or a message, so it waited for a good moment."]),
    ];
    return [
      {
        kind: "tell",
        notification: {
          kind: "reminder",
          title: p.text,
          ...(said.length ? { body: said.join("\n") } : {}),
          urgency: "interrupt",
          ...(vouched ? { deadline: due } : {}),
          // Set after reading an email or a message: its words are still that content's.
          ...(vouched ? {} : { outside: true }),
          dedupeKey: `reminder:${String(p.reminder)}`,
        },
      },
    ];
  },
};
