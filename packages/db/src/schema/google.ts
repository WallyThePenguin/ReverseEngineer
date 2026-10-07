// Google accounts and Calendar. Mirrors migrations/0004_google_calendar.up.sql, the pacing
// tables of 0022_google_pacing.up.sql, the calendar keys of 0032_integrations.up.sql and the
// calendar health of 0046_google_health.up.sql.
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ConnectorSyncState } from "./slack.ts";

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
  /** How this account's calendars are syncing (D61, as Slack and GitHub judge theirs). */
  calendarState: text("calendar_state").$type<ConnectorSyncState>().notNull().default("ok"),
  calendarFailures: integer("calendar_failures").notNull().default(0),
  calendarFailingSince: ts("calendar_failing_since"),
  calendarSyncedAt: ts("calendar_synced_at"),
  calendarError: text("calendar_error"),
});

/** Per account and service ("gmail", "calendar"): a pause Google asked for, shared by every process. */
export const googleQuota = pgTable(
  "google_quota",
  {
    account: text("account").notNull(),
    service: text("service").notNull(),
    pausedUntil: ts("paused_until"),
    /** What Google said when it asked for the pause, and the limit it hit. */
    reason: text("reason"),
  },
  (t) => [primaryKey({ columns: [t.account, t.service] })],
);

/** Every Google call, written before it goes out, so all processes pace against one minute. */
export const googleSpend = pgTable(
  "google_spend",
  {
    account: text("account").notNull(),
    service: text("service").notNull(),
    at: ts("at").notNull(),
    units: integer("units").notNull(),
  },
  (t) => [index("google_spend_window").on(t.account, t.service, t.at)],
);

export const oauthState = pgTable("oauth_state", {
  state: text("state").primaryKey(),
  verifier: text("verifier").notNull(),
  scopes: text("scopes").array().notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
});

/**
 * One account's view of a Google calendar. A calendar two accounts share has a row for each
 * (0032_integrations): `id` is Hearth's own, `googleId` is Google's.
 */
export const calendar = pgTable(
  "calendar",
  {
    id: text("id").primaryKey(),
    account: text("account").notNull(),
    googleId: text("google_id").notNull(),
    title: text("title").notNull(),
    color: text("color"),
    timeZone: text("time_zone"),
    isPrimary: boolean("is_primary").notNull().default(false),
    canWrite: boolean("can_write").notNull().default(false),
    selected: boolean("selected").notNull().default(true),
    lastSyncedAt: ts("last_synced_at"),
    lastError: text("last_error"),
    /** Where Hearth puts new events; at most one calendar has it. */
    writeDefault: boolean("write_default").notNull().default(false),
  },
  (t) => [
    unique().on(t.account, t.googleId),
    uniqueIndex("calendar_write_default").on(t.writeDefault).where(sql`write_default`),
  ],
);

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
    /** Jarvis said yes to it, not you (D71): its guests don't become people (0041). */
    jarvisAccepted: boolean("jarvis_accepted").notNull().default(false),
  },
  (t) => [unique().on(t.calendarId, t.googleId)],
);
