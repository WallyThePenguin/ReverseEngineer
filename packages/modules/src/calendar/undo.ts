// Putting back what Jarvis did to your calendar on its own (D71, D72). Each FYI it leaves carries
// a closed undo, {kind, eventId, before}, that only this module writes; no action's input can set
// it. calendar.undo maps the kind to one exact change, made as you, so a stored row can never
// run anything else.
import { formatTime, localDate } from "@hearth/core";
import { calendarEvent, type NotificationUndo, notification } from "@hearth/db";
import { type ActionContext, ActionError, createNotification, defineAction } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { id } from "../shared.ts";
import { fields, insertEvent, patchEvent, when } from "./actions.ts";
import { answer, mustBeYours } from "./respond.ts";
import { type EventView, loadEvent } from "./store.ts";

/** "Tue 2026-10-13, 10 a.m." or "Tue 2026-10-13, all day": when an FYI says it is. */
export function shortWhen(v: Pick<EventView, "startsAt" | "allDay">, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone }).format(v.startsAt);
  const at = v.allDay ? "all day" : formatTime(v.startsAt, timeZone);
  return `${day} ${localDate(v.startsAt, timeZone)}, ${at}`;
}

/** Its times as the calendar's actions take them back: dates for an all-day event. */
export function timesOf(ev: EventView, timeZone: string) {
  return ev.allDay
    ? { start: localDate(ev.startsAt, timeZone), end: localDate(ev.endsAt, timeZone) }
    : { start: ev.startsAt.toISOString(), end: ev.endsAt.toISOString() };
}

/** The FYI for something Jarvis did on its own, with the one way to put it back. */
export async function tellDone(
  ctx: ActionContext,
  n: { kind: string; title: string; body: string; entityId: string },
  undo: NotificationUndo,
): Promise<void> {
  const created = await createNotification(ctx, { ...n, urgency: "normal" });
  if (created)
    await ctx.tx.update(notification).set({ undo }).where(eq(notification.id, created.id));
}

const undoShape = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("unaccept"),
    eventId: id,
    before: z.object({ scope: z.enum(["this", "all"]) }),
  }),
  z.object({
    kind: z.literal("unmove"),
    eventId: id,
    before: z.object({ start: when, end: when, when: z.string() }),
  }),
  z.object({
    kind: z.literal("unremove"),
    eventId: id,
    before: z.object({
      calendarId: z.string(),
      title: fields.title,
      start: when,
      end: when,
      when: z.string(),
      description: fields.description,
      location: fields.location,
    }),
  }),
]);

/** Back to unanswered, unless you answered it yourself since: then there's nothing to take back. */
async function unaccept(ctx: ActionContext, eventId: string, scope: "this" | "all") {
  const ev = await loadEvent(ctx.tx, eventId);
  if (!ev || ev.status === "cancelled")
    throw new ActionError("not_found", "That meeting isn't on your calendar any more.");
  await mustBeYours(ctx.tx, ev);
  const [row] = await ctx.tx
    .select({ byJarvis: calendarEvent.jarvisAccepted })
    .from(calendarEvent)
    .where(eq(calendarEvent.entityId, ev.id));
  // Jarvis's yes only: one you gave yourself since (in Hearth) isn't its to take back.
  if (ev.selfResponse !== "accepted" || !row?.byJarvis)
    throw new ActionError("conflict", "You've answered this invitation yourself since.");
  return answer(ctx, ev, "needsAction", scope === "all" && ev.recurringEventId ? "all" : undefined);
}

export const undoAction = defineAction({
  name: "calendar.undo",
  description:
    "Put back what Jarvis did to the calendar on its own, from its line in the inbox. The button says exactly what it does.",
  input: z.object({ notificationId: id }),
  risk: "internal",
  // Your button only: Jarvis doesn't take back its own work behind your back.
  callers: ["owner"],
  async handler(i, ctx) {
    const [n] = await ctx.tx
      .select()
      .from(notification)
      .where(eq(notification.id, i.notificationId))
      .for("update");
    if (!n?.undo) throw new ActionError("not_found", "There's nothing to undo here any more.");
    const u = undoShape.parse(n.undo);
    if (u.kind === "unaccept") await unaccept(ctx, u.eventId, u.before.scope);
    else if (u.kind === "unmove")
      await patchEvent(ctx, u.eventId, { start: u.before.start, end: u.before.end });
    else {
      const { when: _, ...event } = u.before;
      await insertEvent(ctx, event);
    }
    await ctx.tx
      .update(notification)
      .set({ undo: null, state: "done", updatedAt: ctx.now })
      .where(eq(notification.id, n.id));
    ctx.emit({
      kind: "notification.updated",
      entityId: n.entityId,
      payload: { notificationId: n.id, state: "done" },
    });
    return { undone: u.kind };
  },
});
