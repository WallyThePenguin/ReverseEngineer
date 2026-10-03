ALTER TABLE mail_thread
  DROP COLUMN IF EXISTS waiting,
  DROP COLUMN IF EXISTS waiting_since,
  DROP COLUMN IF EXISTS no_reply_count,
  DROP COLUMN IF EXISTS nudged_at;
