// Prep (6 a.m.): for each commitment in the next 48 hours, a prep packet linked to the event,
// with what Hearth knows about it: the guests, the last time you met, linked records and open
// tasks. Jarvis writes it up; if it can't, you get the plain facts (PLAN.md section 6.2).
import { formatDateTime, localDate } from "@hearth/core";
import { calendarEvent, entity, link, personEmail, task } from "@hearth/db";
import {
  addLink,
  createEntity,
  defineAction,
  getSetting,
  type ReadContext,
  type RoutineDef,
  updateEntity,
} from "@hearth/kernel";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  lt,
  ne,
  notInArray,
  or,
} from "drizzle-orm";
import { z } from "zod";
import { id, preview } from "../shared.ts";
import { type EventView, guests, toEventView, whenText } from "./store.ts";

const HOUR_MS = 3600_000;

/** Events worth preparing for: not all-day, not declined, not a time block, with guests or long. */
export async function eventsToPrep(ctx: ReadContext, hours = 48): Promise<EventView[]> {
  const min = await getSetting(ctx.db, "calendar.prepMinMinutes");
  const rows = await ctx.db
    .select({ e: entity, r: calendarEvent })
    .from(calendarEvent)
    .innerJoin(entity, eq(entity.id, calendarEvent.entityId))
    .where(
      and(
        isNull(entity.deletedAt),
        ne(calendarEvent.status, "cancelled"),
        eq(calendarEvent.allDay, false),
        isNull(calendarEvent.taskId),
        gt(calendarEvent.startsAt, ctx.now),
        lt(calendarEvent.startsAt, new Date(ctx.now.getTime() + hours * HOUR_MS)),
      ),
    )
    .orderBy(asc(calendarEvent.startsAt));
  return rows
    .map((x) => toEventView(x.e, x.r))
    .filter((v) => v.selfResponse !== "declined")
    .filter(
      (v) => guests(v).length > 0 || v.endsAt.getTime() - v.startsAt.getTime() >= min * 60_000,
    );
}

async function hasPrep(ctx: ReadContext, eventId: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: link.id })
    .from(link)
    .innerJoin(entity, eq(entity.id, link.fromId))
    .where(and(eq(link.toId, eventId), eq(entity.type, "prep"), isNull(entity.deletedAt)));
  return Boolean(row);
}

/** The plain facts for one event's packet. */
export async function prepFacts(ctx: ReadContext, ev: EventView, tz: string): Promise<string> {
  const lines = [`## ${ev.title}`, `- When: ${whenText(ev, tz)}`, `- Event id: ${ev.id}`];
  if (ev.location) lines.push(`- Where: ${ev.location}`);
  if (ev.meetUrl) lines.push(`- Video: ${ev.meetUrl}`);
  const people = guests(ev);
  if (people.length) {
    lines.push(`- Guests: ${people.map((g) => g.name ?? g.email).join(", ")}`);
    // Their addresses, else (for people you added by hand) their name or an address in the notes.
    const byEmail = ctx.db
      .select({ id: personEmail.personId })
      .from(personEmail)
      .where(
        inArray(
          personEmail.address,
          people.map((g) => g.email),
        ),
      );
    const known = await ctx.db
      .select({ id: entity.id, title: entity.title, body: entity.body })
      .from(entity)
      .where(
        and(
          eq(entity.type, "person"),
          isNull(entity.deletedAt),
          or(
            inArray(entity.id, byEmail),
            ...people.map((g) => ilike(entity.body, `%${g.email}%`)),
            ...people.filter((g) => g.name).map((g) => eq(entity.title, g.name!)),
          ),
        ),
      );
    for (const p of known)
      lines.push(`- About ${p.title} (person ${p.id}): ${preview(p.body, 300) || "no notes"}`);
    if (known.length) {
      const open = await ctx.db
        .select({ id: entity.id, title: entity.title, number: task.number })
        .from(link)
        .innerJoin(entity, eq(entity.id, link.fromId))
        .innerJoin(task, eq(task.entityId, entity.id))
        .where(
          and(
            inArray(
              link.toId,
              known.map((k) => k.id),
            ),
            isNull(entity.deletedAt),
            notInArray(task.status, ["completed", "canceled"]),
          ),
        )
        .limit(10);
      for (const t of open) lines.push(`- Open task T-${t.number}: ${t.title}`);
    }
  }
  // The last time this meeting happened, and what was written about it then.
  const [last] = await ctx.db
    .select({ id: entity.id, startsAt: calendarEvent.startsAt })
    .from(calendarEvent)
    .innerJoin(entity, eq(entity.id, calendarEvent.entityId))
    .where(
      and(
        eq(entity.title, ev.title),
        ne(calendarEvent.entityId, ev.id),
        lt(calendarEvent.startsAt, ev.startsAt),
        ne(calendarEvent.status, "cancelled"),
      ),
    )
    .orderBy(desc(calendarEvent.startsAt))
    .limit(1);
  const linkedTo = [ev.id, ...(last ? [last.id] : [])];
  if (last) lines.push(`- Last time: ${formatDateTime(last.startsAt, tz)} (event ${last.id})`);
  const notes = await ctx.db
    .select({ id: entity.id, type: entity.type, title: entity.title, body: entity.body })
    .from(link)
    .innerJoin(entity, eq(entity.id, link.fromId))
    .where(and(inArray(link.toId, linkedTo), isNull(entity.deletedAt), ne(entity.type, "prep")))
    .limit(10);
  for (const n of notes)
    lines.push(`- Linked ${n.type} "${n.title}" (${n.id}): ${preview(n.body, 300)}`);
  // The description is outside content (anyone can send an invite), so it stays out of the
  // prompt; reading the event with record_read marks the turn as having read it (D25).
  if (ev.description) lines.push("- Has a description: read the event to see it.");
  return lines.join("\n");
}

export const prepPublish = defineAction({
  name: "prep.publish",
  description:
    "Save the prep packet for an event: a short markdown brief linked to the event. Replaces an earlier packet for it.",
  input: z.object({ eventId: id, markdown: z.string().min(1).max(30_000) }),
  risk: "internal",
  async handler(i, ctx) {
    const [ev] = await ctx.tx
      .select({ title: entity.title, startsAt: calendarEvent.startsAt })
      .from(calendarEvent)
      .innerJoin(entity, eq(entity.id, calendarEvent.entityId))
      .where(eq(calendarEvent.entityId, i.eventId));
    if (!ev) throw new Error("No such event");
    const rules = await getSetting(ctx.tx, "owner.dayRules");
    const [existing] = await ctx.tx
      .select({ id: entity.id })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.fromId))
      .where(and(eq(link.toId, i.eventId), eq(entity.type, "prep"), isNull(entity.deletedAt)));
    if (existing) {
      await updateEntity(ctx, existing.id, { body: i.markdown });
      return { id: existing.id };
    }
    const row = await createEntity(ctx, {
      type: "prep",
      title: `Prep: ${ev.title} (${localDate(ev.startsAt, rules.timeZone)})`,
      body: i.markdown,
    });
    await addLink(ctx, { fromId: row.id, toId: i.eventId, kind: "derived_from" });
    return { id: row.id };
  },
});

export const prepRoutine: RoutineDef = {
  name: "calendar.prep",
  description: "At 6 a.m., a prep packet for each meeting in the next 48 hours.",
  cron: "0 6 * * *",
  staleAfterSeconds: 3 * 3600,
  async run(_firing, ctx) {
    const rules = await getSetting(ctx.db, "owner.dayRules");
    const todo: { ev: EventView; facts: string }[] = [];
    for (const ev of await eventsToPrep(ctx)) {
      if (await hasPrep(ctx, ev.id)) continue;
      todo.push({ ev, facts: await prepFacts(ctx, ev, rules.timeZone) });
    }
    if (todo.length === 0) return [];
    const date = localDate(ctx.now, rules.timeZone);
    return [
      {
        kind: "turn",
        trigger: "routine",
        lane: "deep",
        dedupeKey: `prep:${date}`,
        context: { routine: "prep", events: todo.length },
        prompt: [
          `Prep time (${date}). For each event below, write a short prep packet: who's coming and what you know about them, what happened last time, open items, and what the owner should have ready. Look up the linked records if they help. Don't invent facts; say what's unknown.`,
          "Call prep_publish once per event with its event id.",
          "",
          ...todo.map((t) => t.facts),
        ].join("\n\n"),
        fallback: todo.map((t) => ({
          kind: "act" as const,
          action: "prep.publish",
          input: { eventId: t.ev.id, markdown: t.facts },
        })),
      },
    ];
  },
};
