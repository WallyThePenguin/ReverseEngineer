ALTER TABLE github_repo DROP COLUMN resume_page, DROP COLUMN backlog_top;
DROP INDEX slack_message_threads;
ALTER TABLE slack_message
  DROP COLUMN latest_reply, DROP COLUMN replies_read, DROP COLUMN replies_at;
ALTER TABLE slack_channel
  DROP COLUMN backlog_ts, DROP COLUMN backlog_top, DROP COLUMN threads_at;
ALTER TABLE github_account
  DROP COLUMN sync_state, DROP COLUMN failures, DROP COLUMN failing_since,
  DROP COLUMN token_expires_at;
ALTER TABLE slack_workspace
  DROP COLUMN sync_state, DROP COLUMN failures, DROP COLUMN failing_since;

-- Drafts kept from an account that's gone can't stay: every draft has an account again.
DELETE FROM entity WHERE id IN (SELECT entity_id FROM mail_draft WHERE account_id IS NULL);
ALTER TABLE mail_draft DROP CONSTRAINT mail_draft_account_id_fkey;
ALTER TABLE mail_draft ADD CONSTRAINT mail_draft_account_id_fkey
  FOREIGN KEY (account_id) REFERENCES mail_account (id) ON DELETE CASCADE;
ALTER TABLE mail_draft ALTER COLUMN account_id SET NOT NULL;
-- "Needs your reply" flags the new rule cleared stay cleared; the next message works them out.
ALTER TABLE mail_message DROP COLUMN bulk;

ALTER TABLE mail_account DROP COLUMN repair_from, DROP COLUMN repaired_at;
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
