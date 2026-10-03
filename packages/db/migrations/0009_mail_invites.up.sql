-- Calendar invitations in mail (M2). A message carrying an invitation keeps its UID and method,
-- and calendar events keep their iCalendar UID, so the two can be matched and answered from the
-- conversation. Events synced before this get their UID the next time Google changes them;
-- Google's own invitations also match by event id.
ALTER TABLE mail_message ADD COLUMN invite jsonb;
ALTER TABLE calendar_event ADD COLUMN ical_uid text;
CREATE INDEX calendar_event_ical_uid ON calendar_event (ical_uid);
CREATE INDEX calendar_event_google_id ON calendar_event (google_id);
CREATE INDEX calendar_event_series ON calendar_event (recurring_event_id);
