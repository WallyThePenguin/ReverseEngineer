// Finding a time with other people (Connections-10 PR 5): your free working hours, less the times
// your guests are busy, as Google's free/busy shows them to one of your accounts. Free/busy gives
// times only, never what the meeting is; a guest whose calendar isn't shared with any of your
// accounts is said to be unseen, so a slot never claims to suit someone it couldn't check.
import { googleAccount } from "@hearth/db";
import { type ActionContext, defineAction, getSetting } from "@hearth/kernel";
import { and, arrayContains, asc, ne } from "drizzle-orm";
import { z } from "zod";
import { CalendarApi } from "../google/calendar-api.ts";
import { GOOGLE_SERVICE, type GoogleClient, SCOPES } from "../google/client.ts";
import { GoogleApiError } from "../google/errors.ts";
import { accountAddresses, addressKey } from "../mail/mine.ts";
import { isoDateTime } from "../shared.ts";
import { busyTimes, type Slot, subtract, workWindows } from "./free.ts";

const DAY_MS = 24 * 3600_000;

export interface Unseen {
  address: string;
  why: string;
}

/** Your guests' busy times, asking each of your calendar accounts in turn for those not yet seen. */
async function guestsBusy(ctx: ActionContext, guests: string[], from: Date, to: Date) {
  const accounts = await ctx.tx
    .select({ email: googleAccount.email })
    .from(googleAccount)
    .where(
      and(
        ne(googleAccount.status, "revoked"),
        arrayContains(googleAccount.scopes, [...SCOPES.calendar]),
      ),
    )
    .orderBy(asc(googleAccount.connectedAt), asc(googleAccount.email));
  const api = new CalendarApi(ctx.service<GoogleClient>(GOOGLE_SERVICE), ctx.tx);
  const busy: Slot[] = [];
  const seen = new Set<string>();
  let asked = false;
  for (const a of accounts) {
    const left = guests.filter((g) => !seen.has(g));
    if (left.length === 0) break;
    const answer = await api.freeBusy(a.email, left, from, to).catch((err: unknown) => {
      // One account's trouble leaves the others to ask.
      if (err instanceof GoogleApiError) return null;
      throw err;
    });
    if (!answer) continue;
    asked = true;
    for (const g of left) {
      const cal = answer[g];
      if (!cal || cal.errors?.length) continue;
      seen.add(g);
      for (const b of cal.busy ?? []) busy.push({ start: new Date(b.start), end: new Date(b.end) });
    }
  }
  const why = asked
    ? "Their calendar isn't shared with any of your Google accounts."
    : "Google couldn't be asked.";
  const unseen: Unseen[] = guests.filter((g) => !seen.has(g)).map((address) => ({ address, why }));
  return { busy, seen: [...seen], unseen };
}

export const findTimeAction = defineAction({
  name: "calendar.find_time",
  description:
    "Times in the owner's working hours (never evenings or weekends) when the owner and every guest are free, for a meeting of `minutes`, from now or `from`, over `days` days. Guests' busy times come from Google's free/busy, where their calendar is shared with one of the owner's accounts (colleagues, usually): `checked` lists those, and `unseen` the guests whose time couldn't be counted. Propose times to someone with calendar.schedule_meeting.",
  input: z.object({
    guests: z.array(z.string().trim().email()).max(20).default([]),
    minutes: z.number().int().min(15).max(480).default(30),
    from: isoDateTime.optional(),
    days: z.number().int().min(1).max(30).default(5),
  }),
  risk: "read",
  async handler(i, ctx) {
    const rules = await getSetting(ctx.tx, "owner.dayRules");
    const from = i.from ? new Date(i.from) : ctx.now;
    const to = new Date(from.getTime() + i.days * DAY_MS);
    // Your own accounts are you: their busy time is in your calendars already.
    const mine = await accountAddresses(ctx.tx);
    const byKey = new Map<string, string>();
    for (const g of i.guests) {
      const key = addressKey(g);
      if (!mine.has(key) && !byKey.has(key)) byKey.set(key, g.toLowerCase());
    }
    const guests = [...byKey.values()];
    const theirs = guests.length
      ? await guestsBusy(ctx, guests, from, to)
      : { busy: [], seen: [], unseen: [] };
    const busy = [...(await busyTimes(ctx.tx, from, to)), ...theirs.busy].sort(
      (a, b) => a.start.getTime() - b.start.getTime(),
    );
    const slots = subtract(workWindows(from, to, rules), busy).filter(
      (s) => s.end.getTime() - s.start.getTime() >= i.minutes * 60_000,
    );
    return { slots: slots.slice(0, 40), checked: theirs.seen, unseen: theirs.unseen };
  },
});
