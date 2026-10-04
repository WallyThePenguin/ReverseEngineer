// The few Google Calendar API calls Hearth makes, typed. Reading counts against Calendar's own
// paced budget; adding, changing or removing an event is something you're waiting on, so it may
// use the headroom reads leave, and a slowdown then says so plainly (D55).
import type { DbOrTx } from "@hearth/db";
import { ActionError } from "@hearth/kernel";
import type { GoogleClient } from "./client.ts";
import { GoogleApiError } from "./errors.ts";

const BASE = "https://www.googleapis.com/calendar/v3";

export interface GCalendar {
  id: string;
  summary: string;
  summaryOverride?: string;
  backgroundColor?: string;
  timeZone?: string;
  primary?: boolean;
  accessRole: "freeBusyReader" | "reader" | "writer" | "owner";
  deleted?: boolean;
}

export interface GTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface GAttendee {
  email: string;
  displayName?: string;
  responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
  self?: boolean;
  organizer?: boolean;
  resource?: boolean;
}

export interface GEvent {
  id: string;
  etag?: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  start?: GTime;
  end?: GTime;
  htmlLink?: string;
  hangoutLink?: string;
  transparency?: "opaque" | "transparent";
  organizer?: { email?: string; self?: boolean };
  attendees?: GAttendee[];
  recurringEventId?: string;
  iCalUID?: string;
  extendedProperties?: { private?: Record<string, string> };
}

export type SendUpdates = "all" | "none";

const enc = encodeURIComponent;

/** A slowdown on something you asked for, said plainly; anything else as it was. */
function plain(err: unknown): never {
  if (err instanceof GoogleApiError && err.slowDown) {
    const secs = Math.max(1, Math.ceil((err.retryAfterMs ?? 60_000) / 1000));
    // "paced": Hearth held it back itself, to keep Google from turning it away.
    const why =
      err.kind === "paced"
        ? "Hearth is spacing out its Google Calendar calls"
        : "Google Calendar asked Hearth to slow down";
    throw new ActionError(
      "unavailable",
      `${why}, so nothing changed. Try again in about ${secs} seconds.`,
    );
  }
  throw err;
}

export class CalendarApi {
  private readonly google: GoogleClient;
  private readonly db: DbOrTx;

  constructor(google: GoogleClient, db: DbOrTx) {
    this.google = google;
    this.db = db;
  }

  async calendars(account: string): Promise<GCalendar[]> {
    const out: GCalendar[] = [];
    let page: string | undefined;
    do {
      const q = new URLSearchParams({ maxResults: "250", ...(page ? { pageToken: page } : {}) });
      const res = await this.google.call<{ items?: GCalendar[]; nextPageToken?: string }>(
        this.db,
        account,
        "GET",
        `${BASE}/users/me/calendarList?${q}`,
      );
      out.push(...(res.items ?? []));
      page = res.nextPageToken;
    } while (page);
    return out;
  }

  /** Every event (each occurrence of a repeating one) that overlaps a window. */
  async events(account: string, calendarId: string, from: Date, to: Date): Promise<GEvent[]> {
    const out: GEvent[] = [];
    let page: string | undefined;
    do {
      const q = new URLSearchParams({
        singleEvents: "true",
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        maxResults: "2500",
        ...(page ? { pageToken: page } : {}),
      });
      const res = await this.google.call<{ items?: GEvent[]; nextPageToken?: string }>(
        this.db,
        account,
        "GET",
        `${BASE}/calendars/${enc(calendarId)}/events?${q}`,
      );
      out.push(...(res.items ?? []));
      page = res.nextPageToken;
    } while (page);
    return out;
  }

  /** A change you asked for: it may use the budget's headroom. */
  private write<T>(account: string, method: string, url: string, body?: unknown): Promise<T> {
    return this.google
      .call<T>(this.db, account, method, url, body, { priority: true })
      .catch(plain);
  }

  insert(account: string, calendarId: string, event: Partial<GEvent>, send: SendUpdates) {
    return this.write<GEvent>(
      account,
      "POST",
      `${BASE}/calendars/${enc(calendarId)}/events?sendUpdates=${send}&conferenceDataVersion=0`,
      event,
    );
  }

  patch(
    account: string,
    calendarId: string,
    eventId: string,
    event: Partial<GEvent>,
    send: SendUpdates,
  ) {
    return this.write<GEvent>(
      account,
      "PATCH",
      `${BASE}/calendars/${enc(calendarId)}/events/${enc(eventId)}?sendUpdates=${send}`,
      event,
    );
  }

  async remove(account: string, calendarId: string, eventId: string, send: SendUpdates) {
    await this.write<null>(
      account,
      "DELETE",
      `${BASE}/calendars/${enc(calendarId)}/events/${enc(eventId)}?sendUpdates=${send}`,
    );
  }
}
