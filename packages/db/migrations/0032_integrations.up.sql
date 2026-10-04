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

-- Mail sent to many at once or by a machine (List-Id, List-Unsubscribe, Precedence: bulk,
-- Auto-Submitted) never needs your reply. Null until the message's original has been read for
-- it: new mail as it arrives, mail already here in the daily repair pass.
ALTER TABLE mail_message ADD COLUMN bulk boolean;
-- "Needs your reply" also wants the sender to be someone you know (a person in Hearth: anyone you
-- write to becomes one) or Gmail to mark the message important (flags.ts waitingOn). The
-- conversations the old rule flagged are checked again by the new one, from their last message
-- (the last one not in the trash, if there is one).
UPDATE mail_thread t SET waiting = NULL
FROM (
  SELECT DISTINCT ON (m.thread_id) m.thread_id, m.from_address, m.labels
  FROM mail_message m
  ORDER BY m.thread_id, ('TRASH' = ANY (m.labels)), m.sent_at DESC
) x
WHERE x.thread_id = t.entity_id AND t.waiting = 'you'
  AND NOT ('IMPORTANT' = ANY (x.labels))
  AND NOT EXISTS (SELECT 1 FROM person_email p WHERE p.address = lower(x.from_address));

-- A draft outlives its account when you say so on disconnecting: it waits, from no account yet,
-- until you pick one to send it from.
ALTER TABLE mail_draft ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE mail_draft DROP CONSTRAINT mail_draft_account_id_fkey;
ALTER TABLE mail_draft ADD CONSTRAINT mail_draft_account_id_fkey
  FOREIGN KEY (account_id) REFERENCES mail_account (id) ON DELETE SET NULL;

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
