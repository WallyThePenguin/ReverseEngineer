-- Phone notifications (M6): each browser or installed app that turned on notifications. The
-- endpoint is where the push service takes messages for it; p256dh and auth encrypt them.
CREATE TABLE push_subscription (
  endpoint text PRIMARY KEY,
  p256dh text NOT NULL,
  auth text NOT NULL,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz
);
