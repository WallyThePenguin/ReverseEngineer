ALTER TABLE mail_draft DROP COLUMN message_id;

DROP INDEX calendar_write_default;
ALTER TABLE calendar DROP COLUMN write_default;

-- Google's id becomes the key again, so a calendar two accounts share can belong to only one of
-- them: the account connected first keeps it, and the other's copy and its events go.
ALTER TABLE calendar_event DROP CONSTRAINT calendar_event_calendar_id_fkey;
CREATE TEMP TABLE calendar_dropped ON COMMIT DROP AS
  SELECT c.id FROM calendar c
  JOIN google_account a ON a.email = c.account
  WHERE EXISTS (
    SELECT 1 FROM calendar o
    JOIN google_account oa ON oa.email = o.account
    WHERE o.google_id = c.google_id AND o.id <> c.id
      AND (oa.connected_at, o.account) < (a.connected_at, c.account)
  );
DELETE FROM entity WHERE id IN (
  SELECT entity_id FROM calendar_event WHERE calendar_id IN (SELECT id FROM calendar_dropped)
);
DELETE FROM calendar WHERE id IN (SELECT id FROM calendar_dropped);
UPDATE calendar_event e SET calendar_id = c.google_id FROM calendar c WHERE e.calendar_id = c.id;
UPDATE calendar SET id = google_id;
ALTER TABLE calendar DROP CONSTRAINT calendar_account_google_id_key;
ALTER TABLE calendar DROP COLUMN google_id;
ALTER TABLE calendar_event ADD CONSTRAINT calendar_event_calendar_id_fkey
  FOREIGN KEY (calendar_id) REFERENCES calendar (id) ON DELETE CASCADE;
