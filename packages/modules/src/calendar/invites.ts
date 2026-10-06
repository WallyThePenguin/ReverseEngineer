// A new invitation becomes one card: accept it with one tap. Whether you're free is plain
// calendar arithmetic, so no model turn is spent; the answer goes out only once you say yes.
import { PRINCIPAL, startOfLocalDay } from "@hearth/core";
import { approval, calendar, calendarEvent, type DbOrTx, entity } from "@hearth/db";
import { getSetting, type ReflexDef } from "@hearth/kernel";
import { and, count, eq, gt, gte, lt, min, ne } from "drizzle-orm";
import { personFor } from "../people/store.ts";
import { inSelectedCalendar } from "./calendars.ts";
import { type EventView, loadEvent } from "./store.ts";

/** Invitation cards in one day: a newly connected calendar can hold dozens of old ones. */
export const INVITE_CARDS = 15;

/** Anyone can put an invitation on a Google calendar; only these get a card. */
const PUBLIC_MAIL = /@(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|aol|proton(mail)?)\./i;

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/** From someone you know, or from your own workplace. */
async function fromSomeoneYouKnow(db: DbOrTx, ev: EventView): Promise<boolean> {
  if (!ev.organizer) return false;
  if (await personFor(db, ev.organizer)) return true;
  const [cal] = await db
    .select({ account: calendar.account })
    .from(calendar)
    .where(eq(calendar.id, ev.calendarId));
  if (!cal || PUBLIC_MAIL.test(cal.account)) return false;
  return domainOf(cal.account) === domainOf(ev.organizer);
}

/** A title as one plain line, so it can't pass for anything else on the card. */
const plain = (title: string) =>
  title
    .replace(/[\p{Cc}\p{Cf}"]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

/** What else you have then: events you haven't declined that block the time. */
async function overlapping(db: DbOrTx, ev: EventView): Promise<string[]> {
  const rows = await db
    .select({ title: entity.title, response: calendarEvent.selfResponse })
    .from(calendarEvent)
    .innerJoin(entity, eq(entity.id, calendarEvent.entityId))
    .innerJoin(calendar, inSelectedCalendar)
    .where(
      and(
        ne(calendarEvent.entityId, ev.id),
        ne(calendarEvent.status, "cancelled"),
        eq(calendarEvent.busy, true),
        lt(calendarEvent.startsAt, ev.endsAt),
        gt(calendarEvent.endsAt, ev.startsAt),
      ),
    );
  return rows.filter((r) => r.response !== "declined").map((r) => plain(r.title));
}

export const newInvite: ReflexDef = {
  name: "calendar.new_invite",
  description: `A new invitation from someone you know becomes one card saying whether you're free; one tap accepts it (up to ${INVITE_CARDS} a day).`,
  mode: "proactive",
  on: ["calendar.event_changed"],
  async run(event, ctx) {
    if (event.payload.change !== "added" || !event.entityId) return [];
    const ev = await loadEvent(ctx.db, event.entityId);
    if (!ev || ev.selfOrganizer || ev.selfResponse !== "needsAction") return [];
    if (ev.status === "cancelled" || ev.startsAt <= ctx.now) return [];
    if (!(await fromSomeoneYouKnow(ctx.db, ev))) return [];
    // A repeating meeting arrives as many times: one card, on the first, answers them all.
    if (ev.recurringEventId) {
      const [first] = await ctx.db
        .select({ at: min(calendarEvent.startsAt) })
        .from(calendarEvent)
        .where(
          and(
            eq(calendarEvent.calendarId, ev.calendarId),
            eq(calendarEvent.recurringEventId, ev.recurringEventId),
            eq(calendarEvent.selfResponse, "needsAction"),
            gt(calendarEvent.startsAt, ctx.now),
          ),
        );
      if (first?.at && first.at.getTime() < ev.startsAt.getTime()) return [];
    }
    const { timeZone } = await getSetting(ctx.db, "owner.dayRules");
    const [today] = await ctx.db
      .select({ n: count() })
      .from(approval)
      .where(
        and(
          eq(approval.action, "calendar.respond"),
          eq(approval.requestedBy, PRINCIPAL.jarvis),
          gte(approval.createdAt, startOfLocalDay(ctx.now, timeZone)),
        ),
      );
    if ((today?.n ?? 0) >= INVITE_CARDS) return [];
    const others = ev.allDay ? [] : await overlapping(ctx.db, ev);
    const why =
      others.length === 0
        ? "You're free then."
        : others.length === 1
          ? `It overlaps "${others[0]}".`
          : `It overlaps "${others[0]}" and ${others.length - 1} more.`;
    return [
      {
        kind: "act",
        action: "calendar.respond",
        input: {
          id: ev.id,
          response: "accepted",
          ...(ev.recurringEventId ? { scope: "all" } : {}),
        },
        ask: why,
      },
    ];
  },
};
