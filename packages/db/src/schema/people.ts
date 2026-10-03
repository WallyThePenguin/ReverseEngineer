// People, companies and meetings (M5). Mirrors migrations/0010_people.up.sql.
import { integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const company = pgTable("company", {
  entityId: uuid("entity_id").primaryKey(),
  /** "acme.example": where its people's mail comes from. */
  domain: text("domain").notNull().unique(),
});

export const person = pgTable("person", {
  entityId: uuid("entity_id").primaryKey(),
  companyId: uuid("company_id"),
  /** Remind you when you haven't talked for this many days. */
  followUpDays: integer("follow_up_days"),
  /** Your own fields: "Birthday", "Kids", "Met at". */
  fields: jsonb("fields").$type<Record<string, string>>().notNull().default({}),
});

// Meeting notes (M5). Mirrors migrations/0011_meetings.up.sql.

export const meeting = pgTable("meeting", {
  entityId: uuid("entity_id").primaryKey(),
  /** The calendar event it was about, if any. One meeting per event. */
  eventId: uuid("event_id").unique(),
  startedAt: ts("started_at").notNull(),
  endedAt: ts("ended_at"),
  /** Jarvis's summary (markdown). Your own notes are the entity's body. */
  summary: text("summary"),
  summarizedAt: ts("summarized_at"),
});

export const meetingSegment = pgTable(
  "meeting_segment",
  {
    meetingId: uuid("meeting_id").notNull(),
    /** From the recorder: the same audio always gives the same id. */
    id: text("id").notNull(),
    /** "me" is your microphone; "them" is everyone else (the system audio). */
    channel: text("channel").$type<"me" | "them">().notNull(),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    text: text("text").notNull(),
  },
  (t) => [primaryKey({ columns: [t.meetingId, t.id] })],
);
