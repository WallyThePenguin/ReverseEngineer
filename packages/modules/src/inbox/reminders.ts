// "Remind me at 3 to call Sam", "in 2 hours": a reminder rings at that minute. It's a one-shot
// schedule (kind "reminder"); when it fires, a reflex puts it in the inbox as an interrupt, even
// while Jarvis is paused. One you asked for (or Jarvis set before reading outside content) has
// its minute as its deadline, so it rings through quiet hours and the day's cap, as you asked.
// One set after reading an email or a message doesn't vouch for its own time (D54): it waits for
// quiet hours to end, and past the day's cap it lands in the inbox without a buzz. One that rings
// late, because Hearth wasn't running at the minute, can't wake you either, and a day late it's a
// quiet line in the inbox. What outside content set is still its words wherever it's read back:
// reading it makes the turn untrusted, and an untrusted turn cancels only what its own
// conversation set. What the owner asks for in a conversation that read outside content earlier,
// or says to the chat mic, still can't wake them, and its words (Jarvis wrote them there) are
// still marked as outside content's, but it isn't counted against outside content.
import {
  addLocalDays,
  asUntrusted,
  atLocal,
  formatDateTime,
  formatTime,
  isQuietHours,
  localDate,
  localParts,
  minuteOfDay,
  nextLocalTime,
  PRINCIPAL,
} from "@hearth/core";
import { schedule } from "@hearth/db";
import {
  type ActionContext,
  ActionError,
  cancelSchedule,
  defineAction,
  getSetting,
  newId,
  type ReflexDef,
  upsertSchedule,
  vouchesForDeadline,
} from "@hearth/kernel";
import { and, asc, count, eq, isNotNull, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { id as uuid } from "../shared.ts";

/** How far ahead a reminder may be set. */
const MAX_AHEAD_MINUTES = 366 * 24 * 60;
/** Said a moment late ("15:00" at 15:00:05), a time still means now, not tomorrow. */
const GRACE_MS = 2 * 60_000;
/** Rung this late, Hearth wasn't running at the minute: it can't wake you now. */
const LATE_MS = 10 * 60_000;
/** A day late, it's a quiet line in the inbox, not an interrupt. */
const STALE_MS = 24 * 3600_000;
/** Reminders set after reading outside content that may wait at once: per conversation, all told. */
export const OUTSIDE_REMINDERS = { each: 3, all: 10 };

const CLOCK = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const DAY_CLOCK = /^(\d{4}-\d{2}-\d{2})[ T]([01]?\d|2[0-3]):([0-5]\d)$/;
const EXACT = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A day the calendar has: "2026-02-30" isn't one. */
const realDate = (day: string) => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === day;
};

/**
 * The next time the clock says `minute`: today; just now, if it was said a moment late; the
 * second time round on the night the clocks go back (1:30 comes twice); or tomorrow.
 */
function timeOfDay(now: Date, minute: number, timeZone: string): Date {
  const today = atLocal(localDate(now, timeZone), minute, timeZone);
  if (today >= now) return today;
  if (now.getTime() - today.getTime() < GRACE_MS) return now;
  const again = new Date(today.getTime() + 3600_000);
  const same = minuteOfDay(again, timeZone) === minute;
  if (again >= now && same && localDate(again, timeZone) === localDate(today, timeZone))
    return again;
  return nextLocalTime(now, minute, timeZone);
}

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
  if (clock) return timeOfDay(now, Number(clock[1]) * 60 + Number(clock[2]), timeZone);
  const day = DAY_CLOCK.exec(at);
  if (day) {
    if (!realDate(day[1]!)) return null;
    const t = atLocal(day[1]!, Number(day[2]) * 60 + Number(day[3]), timeZone);
    return t < now && now.getTime() - t.getTime() < GRACE_MS ? now : t;
  }
  const exact = EXACT.exec(at);
  if (exact) {
    const t = new Date(at);
    if (!realDate(exact[1]!) || Number.isNaN(t.getTime())) return null;
    return t < now && now.getTime() - t.getTime() < GRACE_MS ? now : t;
  }
  return null;
}

/** When a late reminder was for, as you'd say it: "3 p.m.", "yesterday 3 p.m.", "Monday 3 p.m.". */
function whenFor(due: Date, now: Date, timeZone: string): string {
  const day = localDate(due, timeZone);
  const today = localDate(now, timeZone);
  if (day === today) return formatTime(due, timeZone);
  if (day === addLocalDays(today, -1)) return `yesterday ${formatTime(due, timeZone)}`;
  if (day >= addLocalDays(today, -6))
    return `${WEEKDAYS[localParts(due, timeZone).weekday]} ${formatTime(due, timeZone)}`;
  return formatDateTime(due, timeZone);
}

/** What to remind you of, as one plain line. */
const oneLine = (text: string) =>
  text
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Reminders still to ring, with what they say. */
const waiting = (...where: SQL[]) =>
  and(eq(schedule.kind, "reminder"), isNotNull(schedule.nextRunAt), ...where);
/** Set after reading outside content, not by the owner's own ask (#89's reminders included). */
const setOutside = sql`${schedule.payload}->>'vouched' = 'false'
  AND coalesce(${schedule.payload}->>'asked', 'false') <> 'true'`;

/**
 * Jarvis's turn says the owner's own ask still drives it, though it runs untrusted (Caller.asked):
 * nothing was read in it, and it isn't about an outside record. Decided as the turn runs, never
 * from its stored row, which keeps the origin it was asked with after it reads an email.
 */
const ownerAsked = (ctx: ActionContext) =>
  ctx.caller.principal === PRINCIPAL.jarvis && ctx.caller.asked === true;

/**
 * One set after reading outside content can't be one too many: an email can't plant dozens. The
 * owner's own asks never count. Counted one at a time, so two turns can't both take the last.
 */
async function roomOutside(ctx: ActionContext, from: string | null) {
  await ctx.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('reminder_outside'))`);
  const n = async (...where: SQL[]) =>
    (
      await ctx.tx
        .select({ n: count() })
        .from(schedule)
        .where(waiting(setOutside, ...where))
    )[0]?.n ?? 0;
  const here = from
    ? sql`${schedule.payload}->>'from' = ${from}`
    : sql`${schedule.payload}->>'from' IS NULL`;
  if ((await n(here)) >= OUTSIDE_REMINDERS.each || (await n()) >= OUTSIDE_REMINDERS.all)
    throw new ActionError(
      "forbidden",
      "Enough reminders were set after reading outside content already; the owner can set more.",
    );
}

export const reminderActions = [
  defineAction({
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
    callers: ["owner", "agent"],
    async handler(i, ctx) {
      if ((i.at === undefined) === (i.inMinutes === undefined))
        throw new ActionError("invalid_input", "Give either at or inMinutes, not both.");
      const text = oneLine(i.text);
      if (!text) throw new ActionError("invalid_input", "Say what to remind them of.");
      const rules = await getSetting(ctx.tx, "owner.dayRules");
      const { timeZone } = rules;
      const at = reminderTime(i, ctx.now, timeZone);
      if (!at)
        throw new ActionError(
          "invalid_input",
          'Give at as "15:00", "2026-10-09 15:00" (a real day), or an ISO time with its offset.',
        );
      if (at < ctx.now) throw new ActionError("invalid_input", "That time has passed.");
      if (at.getTime() - ctx.now.getTime() > MAX_AHEAD_MINUTES * 60_000)
        throw new ActionError("invalid_input", "A reminder can be at most a year ahead.");
      const vouched = vouchesForDeadline(ctx.caller);
      const from = ctx.caller.conversationId ?? ctx.caller.turnId ?? null;
      const asked = !vouched && ownerAsked(ctx);
      const heard = asked && ctx.caller.heard === true;
      if (!vouched && !asked) await roomOutside(ctx, from);
      const id = newId();
      const { principal: by, origin } = ctx.caller;
      await upsertSchedule(
        ctx.tx,
        {
          id: `reminder:${id}`,
          kind: "reminder",
          runAt: at,
          timeZone,
          payload: {
            reminder: id,
            text,
            vouched,
            by,
            origin,
            from,
            asked,
            ...(heard ? { heard } : {}),
            // Set after reading outside content, though you asked: Jarvis still wrote its words, so
            // its clock's event carries them as that content's, and says so.
            ...(vouched ? {} : { outside: true }),
          },
        },
        ctx.now,
      );
      const when = formatDateTime(at, timeZone);
      if (vouched) return { id, at: at.toISOString(), when };
      // Said in the chat line, so you know why it won't ring when you asked.
      const morning = formatTime(nextLocalTime(at, rules.quietEnd, timeZone), timeZone);
      const why = heard
        ? "you said it aloud rather than typed it, so it can't wake you"
        : "this conversation read an email or a message, so it can't wake you";
      return {
        id,
        at: at.toISOString(),
        when,
        note: isQuietHours(at, rules)
          ? `It rings at ${morning} rather than ${formatTime(at, timeZone)}: ${why}. Past the day's cap, it goes in the inbox without a buzz.`
          : `It rings at ${formatTime(at, timeZone)} unless the day's interrupts are spent: ${why}, and then it goes in the inbox without a buzz.`,
      };
    },
  }),
  defineAction({
    name: "reminder.list",
    description: "The owner's reminders still to ring, soonest first: id, what, and when.",
    input: z.object({}),
    risk: "read",
    callers: ["owner", "agent"],
    async handler(_i, ctx) {
      const { timeZone } = await getSetting(ctx.tx, "owner.dayRules");
      const rows = await ctx.tx
        .select({ at: schedule.nextRunAt, payload: schedule.payload })
        .from(schedule)
        .where(waiting())
        .orderBy(asc(schedule.nextRunAt));
      return rows.map((r) => {
        const p = r.payload as {
          reminder: string;
          text: string;
          vouched?: boolean;
          asked?: boolean;
        };
        return {
          id: p.reminder,
          // One an email or a message led to is still its words: reading it lowers trust.
          text: p.vouched === false ? asUntrusted(p.text, "reminder") : p.text,
          at: r.at!.toISOString(),
          when: formatDateTime(r.at!, timeZone),
          setAfterOutsideContent: p.vouched === false,
          // Asked for in a conversation that had read outside content: Jarvis still wrote its words.
          ...(p.vouched === false && p.asked === true ? { asked: true } : {}),
          ...(p.vouched === false ? { outside: true } : {}),
        };
      });
    },
  }),
  defineAction({
    name: "reminder.cancel",
    description:
      "Cancel a reminder before it rings (its id from reminder.list), when the owner says so. After reading outside content, only one set from this same conversation after reading it.",
    input: z.object({ id: uuid }),
    risk: "internal",
    callers: ["owner", "agent"],
    async handler(i, ctx) {
      const [r] = await ctx.tx
        .select({ payload: schedule.payload })
        .from(schedule)
        .where(waiting(eq(schedule.id, `reminder:${i.id}`)));
      if (!r) throw new ActionError("not_found", "No reminder like that is waiting to ring.");
      // An email can't call off what you asked for, nor what another conversation set: only
      // what outside content set from this same conversation.
      const p = r.payload as { vouched?: boolean; asked?: boolean; from?: string | null };
      const here = ctx.caller.conversationId ?? ctx.caller.turnId ?? null;
      const outsideHere = p.vouched === false && p.asked !== true && !!here && p.from === here;
      if (!vouchesForDeadline(ctx.caller) && !outsideHere)
        throw new ActionError(
          "forbidden",
          "After reading outside content, Jarvis can cancel only a reminder it set from this conversation after reading it. The owner can cancel any in Settings, under Coming up.",
        );
      await cancelSchedule(ctx.tx, `reminder:${i.id}`);
      return { canceled: true };
    },
  }),
];

export const ringReminder: ReflexDef = {
  name: "reminder.ring",
  description:
    "When a reminder's minute comes, it rings: an interrupt in the inbox, even while Jarvis is paused.",
  mode: "always",
  on: ["clock.fired"],
  async run(event, ctx) {
    const p = event.payload;
    if (p.kind !== "reminder" || typeof p.text !== "string") return [];
    const due = new Date(String(p.scheduledFor));
    const lateBy = ctx.now.getTime() - due.getTime();
    // Hearth was down at the minute: ringing now isn't what you asked for, so it can't wake you.
    const vouched = p.vouched === true && lateBy <= LATE_MS;
    const { timeZone } = await getSetting(ctx.db, "owner.dayRules");
    const said = [
      ...(lateBy > LATE_MS
        ? [`For ${whenFor(due, ctx.now, timeZone)}; Hearth wasn't running then.`]
        : []),
      ...(p.vouched !== true
        ? [
            p.asked !== true
              ? "Jarvis set this after reading an email or a message, so it can't wake you."
              : p.heard === true
                ? "You asked for this aloud rather than typed it, so it can't wake you."
                : "You asked for this in a conversation that had read an email or a message, so it can't wake you.",
          ]
        : p.by === PRINCIPAL.jarvis && p.origin !== "owner"
          ? ["Jarvis set this."]
          : []),
    ];
    return [
      {
        kind: "tell",
        notification: {
          kind: "reminder",
          title: p.text,
          ...(said.length ? { body: said.join("\n") } : {}),
          urgency: lateBy > STALE_MS ? "normal" : "interrupt",
          ...(vouched ? { deadline: due } : {}),
          // Set after reading an email or a message, though you asked: its words are still that
          // content's, as Jarvis wrote them there.
          ...(p.vouched !== true ? { outside: true } : {}),
          dedupeKey: `reminder:${String(p.reminder)}`,
        },
      },
    ];
  },
};
