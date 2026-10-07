-- A draft's version, raised by every change to it. The composer saves on the version it last saw,
-- so a change made meanwhile (Jarvis, another screen) is merged rather than written over, and a
-- Send goes out only as the version you saw.
ALTER TABLE mail_draft ADD COLUMN version integer NOT NULL DEFAULT 0;
