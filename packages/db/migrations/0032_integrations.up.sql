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

-- Slack and GitHub say once that they've stopped syncing, when it starts, and close the notice
-- when they sync again. A token that stops working stops the polling ('revoked') until you give
-- Hearth a new one.
ALTER TABLE slack_workspace
  ADD COLUMN sync_state text NOT NULL DEFAULT 'ok' CHECK (sync_state IN ('ok', 'failing', 'revoked')),
  ADD COLUMN failures integer NOT NULL DEFAULT 0,
  ADD COLUMN failing_since timestamptz;
ALTER TABLE github_account
  ADD COLUMN sync_state text NOT NULL DEFAULT 'ok' CHECK (sync_state IN ('ok', 'failing', 'revoked')),
  ADD COLUMN failures integer NOT NULL DEFAULT 0,
  ADD COLUMN failing_since timestamptz,
  -- When GitHub says the token stops working, so you're told a week ahead.
  ADD COLUMN token_expires_at timestamptz;

-- A busy channel: when more came in than a round reads, the newest are read first and the rest
-- in later rounds, older than backlog_ts; once they're in, reading carries on from backlog_top.
-- threads_at: when the channel's recent messages were last looked over for new thread replies.
ALTER TABLE slack_channel
  ADD COLUMN backlog_ts text,
  ADD COLUMN backlog_top text,
  ADD COLUMN threads_at timestamptz;
-- Threads: Slack's newest reply as last heard, the newest reply read in, and when Hearth looked.
ALTER TABLE slack_message
  ADD COLUMN latest_reply text,
  ADD COLUMN replies_read text,
  ADD COLUMN replies_at timestamptz;
CREATE INDEX slack_message_threads ON slack_message (replies_at NULLS FIRST)
  WHERE latest_reply IS NOT NULL;

-- More pull requests changed than a round reads: the page to carry on from, and the newest change
-- seen, where reading goes on from once the rest are in.
ALTER TABLE github_repo ADD COLUMN resume_page integer, ADD COLUMN backlog_top timestamptz;
