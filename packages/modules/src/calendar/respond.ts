// Answering an invitation. Only your own answer changes: the guest list goes back to Google as
// Google has it right now, so nobody else's answer, note or extra guests are touched. A repeating
// meeting is answered for this time only or for every time, as you say (6.7).
import { calendarEvent } from "@hearth/db";
import { type ActionContext, ActionError, defineAction, type ReadContext } from "@hearth/kernel";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { id } from "../shared.ts";
import { api, meetingText, save } from "./actions.ts";
import { writableCalendar } from "./calendars.ts";
import { loadEvent } from "./store.ts";

type Response = "accepted" | "declined" | "tentative";

/** Every time of a series Hearth knows of takes your answer, until the next sync says more. */
async function answerSeries(ctx: ActionContext, calendarId: string, series: string, r: Response) {
  const rows = await ctx.tx
    .select({ id: calendarEvent.entityId, attendees: calendarEvent.attendees })
    .from(calendarEvent)
    .where(
      and(eq(calendarEvent.calendarId, calendarId), eq(calendarEvent.recurringEventId, series)),
    );
  for (const row of rows)
    await ctx.tx
      .update(calendarEvent)
      .set({
        selfResponse: r,
        attendees: row.attendees.map((a) => (a.self ? { ...a, response: r } : a)),
      })
      .where(eq(calendarEvent.entityId, row.id));
}

const scopeText = (scope?: "this" | "all") =>
  scope === "all" ? ", every time it repeats" : scope === "this" ? ", this time only" : "";

export const respondAction = defineAction({
  name: "calendar.respond",
  description:
    'Answer an invitation: accepted, declined or tentative. The organizer sees it. For a repeating meeting, give scope "this" (this time only) or "all" (every time).',
  input: z.object({
    id,
    response: z.enum(["accepted", "declined", "tentative"]),
    scope: z
      .enum(["this", "all"])
      .optional()
      .describe("For a repeating meeting: this time only, or every time."),
    snapshot: z
      .object({ event: z.string() })
      .optional()
      .describe("Filled in by Hearth: the event. Leave it out."),
  }),
  risk: "outward",
  // So the approval names the meeting as the calendar has it, and the answer goes only to that
  // meeting as it was when you said yes.
  async snapshot(i: { id: string }, ctx: ReadContext) {
    const ev = await loadEvent(ctx.db, i.id);
    if (!ev) throw new Error("No event with that id.");
    return { snapshot: { event: await meetingText(ctx.db, ev) } };
  },
  summarize: (i) =>
    `Answer the invitation to ${i.snapshot?.event ?? `event ${i.id}`}: ${i.response}${scopeText(i.scope)}`,
  async handler(i, ctx) {
    const ev = await loadEvent(ctx.tx, i.id);
    if (!ev) throw new ActionError("not_found", "Event not found");
    if (
      i.snapshot
        ? i.snapshot.event !== (await meetingText(ctx.tx, ev))
        : ctx.caller.kind !== "owner"
    )
      throw new ActionError(
        "conflict",
        "The meeting changed since you were asked, so it wasn't answered.",
      );
    if (ev.recurringEventId && !i.scope)
      throw new ActionError(
        "invalid_input",
        'This meeting repeats. Answer for this time only (scope "this") or every time (scope "all").',
      );
    const cal = await writableCalendar(ctx, ev.calendarId);
    const series = i.scope === "all" ? ev.recurringEventId : null;
    const target = series ?? ev.googleId;
    const calendarApi = api(ctx);
    // Google's guest list as it is now, not Hearth's copy of it.
    const fresh = await calendarApi.get(cal.account, cal.googleId, target);
    if (!fresh || fresh.status === "cancelled")
      throw new ActionError("not_found", "Google Calendar no longer has this meeting.");
    const guests = fresh.attendees ?? [];
    if (!guests.some((a) => a.self))
      throw new ActionError("invalid_input", "You're not a guest on this event.");
    const attendees = guests.map((a) => (a.self ? { ...a, responseStatus: i.response } : a));
    const g = await calendarApi.patch(cal.account, cal.googleId, target, { attendees }, "all");
    if (!series) return save(ctx, cal.id, g);
    await answerSeries(ctx, cal.id, series, i.response);
    return loadEvent(ctx.tx, ev.id);
  },
});
