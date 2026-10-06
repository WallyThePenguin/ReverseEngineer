ALTER TABLE google_quota DROP COLUMN reason;
ALTER TABLE google_account
  DROP COLUMN calendar_state,
  DROP COLUMN calendar_failures,
  DROP COLUMN calendar_failing_since,
  DROP COLUMN calendar_synced_at,
  DROP COLUMN calendar_error;
