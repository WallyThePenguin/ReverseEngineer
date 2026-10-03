// Google accounts and Calendar. Mirrors migrations/0004_google_calendar.up.sql.
import { sql } from "drizzle-orm";
import { boolean, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const googleAccount = pgTable("google_account", {
  email: text("email").primaryKey(),
  refreshToken: text("refresh_token").notNull(),
  scopes: text("scopes").array().notNull().default(sql`'{}'`),
  accessToken: text("access_token"),
  accessExpiresAt: ts("access_expires_at"),
  connectedAt: ts("connected_at").notNull().defaultNow(),
  status: text("status").$type<"ok" | "failing" | "revoked">().notNull().default("ok"),
  lastError: text("last_error"),
});

export const oauthState = pgTable("oauth_state", {
  state: text("state").primaryKey(),
  verifier: text("verifier").notNull(),
  scopes: text("scopes").array().notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
});

export const calendar = pgTable("calendar", {
  id: text("id").primaryKey(),
  account: text("account").notNull(),
  title: text("title").notNull(),
  color: text("color"),
  timeZone: text("time_zone"),
  isPrimary: boolean("is_primary").notNull().default(false),
  canWrite: boolean("can_write").notNull().default(false),
  selected: boolean("selected").notNull().default(true),
  lastSyncedAt: ts("last_synced_at"),
  lastError: text("last_error"),
});

export interface Attendee {
  email: string;
  name?: string;
  response?: string;
  self?: boolean;
  organizer?: boolean;
}

export type EventStatus = "confirmed" | "tentative" | "cancelled";

export const calendarEvent = pgTable(
  "calendar_event",
  {
    entityId: uuid("entity_id").primaryKey(),
    calendarId: text("calendar_id").notNull(),
    googleId: text("google_id").notNull(),
    etag: text("etag"),
    status: text("status").$type<EventStatus>().notNull().default("confirmed"),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at").notNull(),
    allDay: boolean("all_day").notNull().default(false),
    location: text("location"),
    meetUrl: text("meet_url"),
    htmlLink: text("html_link"),
    busy: boolean("busy").notNull().default(true),
    organizer: text("organizer"),
    selfOrganizer: boolean("self_organizer").notNull().default(true),
    selfResponse: text("self_response"),
    attendees: jsonb("attendees").$type<Attendee[]>().notNull().default([]),
    recurringEventId: text("recurring_event_id"),
    /** The iCalendar UID, shared with the invitation emails (0009_mail_invites). */
    icalUid: text("ical_uid"),
    taskId: uuid("task_id"),
    /** Its guests are linked to people (0010_people). */
    peopleLinked: boolean("people_linked").notNull().default(false),
  },
  (t) => [unique().on(t.calendarId, t.googleId)],
);
