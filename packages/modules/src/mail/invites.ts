// Calendar invitations in mail: the iCalendar part is read once when the message arrives, and
// matched to the live event on your calendar, so you can answer from the conversation. What the
// conversation shows and answers is the calendar's event, never the email's description of it.
import { atLocal } from "@hearth/core";
import {
  calendar,
  calendarEvent,
  type DbOrTx,
  entity,
  googleAccount,
  type MailInvite,
} from "@hearth/db";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { ownAccount } from "../calendar/calendars.ts";

/** Lines with their continuations joined (RFC 5545 folding). */
const unfold = (ics: string) => ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);

/** "DTSTART;TZID=Europe/Paris:20261005T150000" → its name, parameters and value. */
function property(line: string) {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const [name, ...params] = line.slice(0, colon).split(";");
  const p: Record<string, string> = {};
  for (const x of params) {
    const [k, v] = x.split("=");
    if (k && v) p[k.toUpperCase()] = v.replace(/^"|"$/g, "");
  }
  return { name: name!.toUpperCase(), params: p, value: line.slice(colon + 1) };
}

const plainText = (s: string) =>
  s
    .replace(/\\n/gi, " ")
    .replace(/\\([,;\\])/g, "$1")
    .trim();

function startOf(value: string, tz: string | undefined): string | null {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h) return null;
  if (z) return new Date(Date.UTC(+y!, +mo! - 1, +d!, +h, +mi!, +s!)).toISOString();
  try {
    return atLocal(`${y}-${mo}-${d}`, +h * 60 + +mi!, tz ?? "UTC").toISOString();
  } catch {
    return null; // A time zone name Hearth doesn't know (Outlook's own names).
  }
}

/** The invitation in an iCalendar file, or null if it isn't one Hearth answers. */
export function parseInvite(ics: string): MailInvite | null {
  let method = "";
  let inEvent = false;
  const ev: Record<string, { params: Record<string, string>; value: string }> = {};
  for (const line of unfold(ics)) {
    const p = property(line);
    if (!p) continue;
    if (p.name === "METHOD" && !inEvent) method = p.value.trim().toUpperCase();
    else if (p.name === "BEGIN" && p.value.trim().toUpperCase() === "VEVENT") inEvent = true;
    else if (p.name === "END" && p.value.trim().toUpperCase() === "VEVENT") break;
    else if (inEvent && !ev[p.name]) ev[p.name] = p;
  }
  const uid = ev.UID?.value.trim();
  if (!uid || uid.length > 500 || !["REQUEST", "CANCEL"].includes(method)) return null;
  const organizer =
    ev.ORGANIZER?.value
      .replace(/^mailto:/i, "")
      .trim()
      .toLowerCase()
      .slice(0, 320) || null;
  return {
    uid,
    method,
    summary: plainText(ev.SUMMARY?.value ?? "").slice(0, 300),
    start: ev.DTSTART ? startOf(ev.DTSTART.value.trim(), ev.DTSTART.params.TZID) : null,
    organizer,
  };
}

/** Is this attachment an iCalendar file? */
export const isCalendar = (a: { mimeType: string; filename: string }) =>
  /^(text\/calendar|application\/ics)$/i.test(a.mimeType) || /\.ics$/i.test(a.filename);

/**
 * The event on your calendar an invitation is about: the same UID (or, for Google's own
 * invitations, the same event id), from the same organizer. For a repeating meeting, the
 * occurrence nearest the invitation's start, else the series. Only a copy on a calendar of your
 * own: on one someone shared with you, "you" is its owner, and answering would answer as them. An
 * invitation to two of your accounts is on each one's calendar: the copy on the calendar of
 * `account` (the address it came to) is the one, so it's answered as that address (D61); else one
 * on a calendar you sync.
 */
export async function matchInvite(
  db: DbOrTx,
  invite: MailInvite,
  account?: string,
): Promise<string | null> {
  const googleId = invite.uid.replace(/@google\.com$/i, "");
  const rows = await db
    .select({
      id: calendarEvent.entityId,
      startsAt: calendarEvent.startsAt,
      organizer: calendarEvent.organizer,
      series: calendarEvent.recurringEventId,
      calendar: calendar.googleId,
      selected: calendar.selected,
    })
    .from(calendarEvent)
    .innerJoin(entity, eq(entity.id, calendarEvent.entityId))
    .innerJoin(calendar, eq(calendar.id, calendarEvent.calendarId))
    .innerJoin(googleAccount, ownAccount)
    .where(
      and(
        isNull(entity.deletedAt),
        or(
          eq(calendarEvent.icalUid, invite.uid),
          inArray(calendarEvent.googleId, [googleId]),
          eq(calendarEvent.recurringEventId, googleId),
        ),
      ),
    )
    .limit(200);
  // Anyone can send an invitation naming any UID; only the meeting's organizer counts.
  const organized = rows.filter((r) => invite.organizer && r.organizer === invite.organizer);
  const mine = organized.filter((r) => account && r.calendar === account.toLowerCase());
  const synced = organized.filter((r) => r.selected);
  const same = mine.length ? mine : synced.length ? synced : organized;
  if (same.length === 0) return null;
  const at = invite.start ? new Date(invite.start).getTime() : null;
  const pick =
    at === null
      ? (same.find((r) => !r.series) ?? same[0])
      : same.reduce((best, r) =>
          Math.abs(r.startsAt.getTime() - at) < Math.abs(best.startsAt.getTime() - at) ? r : best,
        );
  return pick!.id;
}
