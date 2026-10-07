// Jarvis moving or removing an event it added itself, without asking (D72): only one it added, with
// no guests, tied to the email or conversation this turn is about (create_event's threadId). Each
// handler checks all three as it runs; any other event is calendar.update_event or delete_event,
// which ask. Each change leaves an FYI you can undo.
import { PRINCIPAL } from "@hearth/core";
import { entity, link } from "@hearth/db";
import { type ActionContext, ActionError, defineAction, getSetting } from "@hearth/kernel";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { id } from "../shared.ts";
import { turnSubjects } from "./about.ts";
import { fields, patchEvent, plainTitle, removeEvent } from "./actions.ts";
import { type EventView, guests, loadEvent } from "./store.ts";
import { shortWhen, tellDone, timesOf } from "./undo.ts";

/** Why it didn't ask. */
const why = (did: string) =>
  `Jarvis added it from the conversation it was working on, so it ${did} it without asking.`;

/** The event, if Jarvis may change it unasked; otherwise why not, and the action that asks. */
async function ownEvent(ctx: ActionContext, eventId: string, asks: string): Promise<EventView> {
  const refuse = (why: string) =>
    new ActionError("forbidden", `${why} Use ${asks}; this one asks first.`);
  const ev = await loadEvent(ctx.tx, eventId);
  if (!ev || ev.status === "cancelled") throw new ActionError("not_found", "Event not found");
  const [made] = await ctx.tx
    .select({ by: entity.createdBy })
    .from(entity)
    .where(eq(entity.id, ev.id));
  if (made?.by !== PRINCIPAL.jarvis) throw refuse("Jarvis didn't add this event.");
  if (guests(ev).length > 0) throw refuse("This event has guests.");
  const about = await turnSubjects(ctx.tx, ctx.caller);
  // One thing at a time: a heartbeat turn with several emails asks, so one email can't move
  // what another one's event was for.
  if (about.length > 1) throw refuse("This turn is about more than one email or conversation.");
  const [tied] = about.length
    ? await ctx.tx
        .select({ id: link.id })
        .from(link)
        .innerJoin(entity, eq(entity.id, link.fromId))
        .where(
          and(
            eq(link.fromId, ev.id),
            eq(link.kind, "derived_from"),
            inArray(link.toId, about),
            // Tied by calendar_create_event as it added the event, in the same moment: never by
            // link_add, or by a create that found the event already there.
            eq(link.createdBy, PRINCIPAL.jarvis),
            eq(link.createdAt, entity.createdAt),
          ),
        )
        .limit(1)
    : [];
  if (!tied) throw refuse("It wasn't added from what this turn is about.");
  return ev;
}

export const ownEventActions = [
  defineAction({
    name: "calendar.move_own_event",
    description:
      "Move an event you added yourself (calendar_create_event with threadId) from this same email or conversation, when it gives a new time: without asking. It has no guests. For any other event this is refused: use calendar_update_event, which asks the owner first.",
    input: z.object({ id, start: fields.start, end: fields.end }),
    risk: "internal",
    callers: ["agent"],
    async handler(i, ctx) {
      const ev = await ownEvent(ctx, i.id, "calendar_update_event");
      const { timeZone } = await getSetting(ctx.tx, "owner.dayRules");
      const before = { ...timesOf(ev, timeZone), when: shortWhen(ev, timeZone) };
      const moved = await patchEvent(ctx, ev.id, { start: i.start, end: i.end });
      await tellDone(
        ctx,
        {
          kind: "calendar.moved",
          title: `Moved ${plainTitle(ev.title)} to ${shortWhen(moved, timeZone)}`,
          body: `${why("moved")} It was ${before.when}${before.when.endsWith(".") ? "" : "."}`,
          entityId: ev.id,
        },
        { kind: "unmove", eventId: ev.id, before },
      );
      return moved;
    },
  }),
  defineAction({
    name: "calendar.remove_own_event",
    description:
      "Remove an event you added yourself (calendar_create_event with threadId) from this same email or conversation, when it's called off: without asking. It has no guests. For any other event this is refused: use calendar_delete_event, which asks the owner first.",
    input: z.object({ id }),
    risk: "internal",
    callers: ["agent"],
    async handler(i, ctx) {
      const ev = await ownEvent(ctx, i.id, "calendar_delete_event");
      const { timeZone } = await getSetting(ctx.tx, "owner.dayRules");
      const at = shortWhen(ev, timeZone);
      const done = await removeEvent(ctx, ev.id);
      await tellDone(
        ctx,
        {
          kind: "calendar.removed",
          title: `Removed ${plainTitle(ev.title)}, ${at}`,
          body: why("removed"),
          entityId: ev.id,
        },
        {
          kind: "unremove",
          eventId: ev.id,
          before: {
            calendarId: ev.calendarId,
            title: ev.title,
            ...timesOf(ev, timeZone),
            when: at,
            ...(ev.description ? { description: ev.description } : {}),
            ...(ev.location ? { location: ev.location } : {}),
          },
        },
      );
      return done;
    },
  }),
];
