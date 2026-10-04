-- Paced Google calls (D55). Google limits how much each account may ask of Gmail, and separately
-- of Calendar, per minute, and Hearth's server, worker and Jarvis all spend from that one
-- allowance. Each call is written to google_spend before it goes out, so the three processes pace
-- against the same rolling minute. A pause Google asks for is kept on google_quota for all of them.
CREATE TABLE google_quota (
  account text NOT NULL,
  -- 'gmail' or 'calendar': each has its own quota at Google.
  service text NOT NULL,
  paused_until timestamptz,
  PRIMARY KEY (account, service)
);

CREATE TABLE google_spend (
  account text NOT NULL,
  service text NOT NULL,
  at timestamptz NOT NULL,
  units integer NOT NULL
);
CREATE INDEX google_spend_window ON google_spend (account, service, at);

-- How each mail account's sync is going: ok, catching_up (still bringing mail in), paused (Gmail
-- asked Hearth to slow down, until paused_until) or failing. failures counts failed syncs in a
-- row and failing_since is when the first of them was; a slowdown is not a failure.
ALTER TABLE mail_account
  ADD COLUMN paused_until timestamptz,
  ADD COLUMN sync_state text NOT NULL DEFAULT 'ok'
    CHECK (sync_state IN ('ok', 'catching_up', 'paused', 'failing')),
  ADD COLUMN failures integer NOT NULL DEFAULT 0,
  ADD COLUMN failing_since timestamptz;

-- Messages Hearth couldn't save after a few tries, set aside so they never hold up the rest.
CREATE TABLE mail_quarantine (
  account_id text NOT NULL REFERENCES mail_account (id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  first_failed_at timestamptz NOT NULL,
  last_failed_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, provider_id)
);

-- A "Mail isn't syncing" alert from before this change was never closed when sync recovered.
-- Counting it as a failure lets the next good sync close it, the way it closes new ones.
UPDATE mail_account SET failures = 1
WHERE EXISTS (
  SELECT 1 FROM notification
  WHERE dedupe_key LIKE 'mail.sync\_failed:%' AND state <> 'done'
);
