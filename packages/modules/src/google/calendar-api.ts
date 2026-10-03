// The few Google Calendar API calls Hearth makes, typed.
import type { DbOrTx } from "@hearth/db";
import type { GoogleClient } from "./client.ts";

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

  insert(account: string, calendarId: string, event: Partial<GEvent>, send: SendUpdates) {
    return this.google.call<GEvent>(
      this.db,
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
    return this.google.call<GEvent>(
      this.db,
      account,
      "PATCH",
      `${BASE}/calendars/${enc(calendarId)}/events/${enc(eventId)}?sendUpdates=${send}`,
      event,
    );
  }

  async remove(account: string, calendarId: string, eventId: string, send: SendUpdates) {
    await this.google.call<null>(
      this.db,
      account,
      "DELETE",
      `${BASE}/calendars/${enc(calendarId)}/events/${enc(eventId)}?sendUpdates=${send}`,
    );
  }
}
