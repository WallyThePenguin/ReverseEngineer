DROP INDEX IF EXISTS calendar_event_ical_uid;
ALTER TABLE calendar_event DROP COLUMN IF EXISTS ical_uid;
ALTER TABLE mail_message DROP COLUMN IF EXISTS invite;
