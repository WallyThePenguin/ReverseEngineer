DROP TABLE mail_quarantine;
ALTER TABLE mail_account
  DROP COLUMN failing_since,
  DROP COLUMN failures,
  DROP COLUMN sync_state,
  DROP COLUMN paused_until;
DROP TABLE google_spend;
DROP TABLE google_quota;
