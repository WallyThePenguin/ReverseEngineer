-- Every account syncs on its own; outward calls are idempotent (D61).

-- Calendars are keyed by account and Google's id. A calendar two accounts share (a holiday
-- calendar, a colleague's) has the same Google id in both, so with Google's id as the key the
-- second account's copy couldn't be saved. Each account now has its own row, under an id of
-- Hearth's own; google_id is what Google calls it.
ALTER TABLE calendar_event DROP CONSTRAINT calendar_event_calendar_id_fkey;
ALTER TABLE calendar ADD COLUMN google_id text, ADD COLUMN new_id text;
UPDATE calendar SET google_id = id, new_id = gen_random_uuid()::text;
UPDATE calendar_event e SET calendar_id = c.new_id FROM calendar c WHERE e.calendar_id = c.id;
UPDATE calendar SET id = new_id;
ALTER TABLE calendar DROP COLUMN new_id;
ALTER TABLE calendar ALTER COLUMN google_id SET NOT NULL;
ALTER TABLE calendar ADD CONSTRAINT calendar_account_google_id_key UNIQUE (account, google_id);
ALTER TABLE calendar_event ADD CONSTRAINT calendar_event_calendar_id_fkey
  FOREIGN KEY (calendar_id) REFERENCES calendar (id) ON DELETE CASCADE;

-- The calendar Hearth puts new events and time blocks on, chosen in Settings. At most one; with
-- none, it's the primary calendar of the account connected first.
ALTER TABLE calendar ADD COLUMN write_default boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX calendar_write_default ON calendar (write_default) WHERE write_default;

-- A draft's Message-ID is chosen when it's written, not when it's sent, so a send that may have
-- gone out (Gmail didn't answer, or Hearth stopped mid-way) is found in Sent, not sent twice.
ALTER TABLE mail_draft ADD COLUMN message_id text;
UPDATE mail_draft d
  SET message_id = replace(gen_random_uuid()::text, '-', '') || '@' || split_part(a.address, '@', 2)
  FROM mail_account a WHERE a.id = d.account_id;
ALTER TABLE mail_draft ALTER COLUMN message_id SET NOT NULL;

-- Once a day each account looks for messages whose original is missing from this PC and fetches
-- them again, a few at a time: where it got to, and when it last went all the way through.
ALTER TABLE mail_account ADD COLUMN repair_from uuid, ADD COLUMN repaired_at timestamptz;
