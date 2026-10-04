-- Slack (M7): your workspace read in with your own token, sealed with the vault key. Messages are
-- records written by other people (outside content); ones that @mention you reach the inbox.
INSERT INTO principal (id, kind, display_name) VALUES ('integration:slack', 'integration', 'Slack');

CREATE TABLE slack_workspace (
  team_id text PRIMARY KEY,
  team_name text NOT NULL,
  url text NOT NULL,
  user_id text NOT NULL,
  -- The User OAuth Token, sealed (never stored or logged in the clear).
  token text NOT NULL,
  channels_at timestamptz,
  mentions_ts text,
  synced_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE slack_channel (
  id text PRIMARY KEY,
  team_id text NOT NULL REFERENCES slack_workspace (team_id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('channel', 'private', 'group', 'dm')),
  dm_user text,
  ingest boolean NOT NULL DEFAULT true,
  last_ts text,
  polled_at timestamptz
);

CREATE TABLE slack_user (
  id text PRIMARY KEY,
  team_id text NOT NULL REFERENCES slack_workspace (team_id) ON DELETE CASCADE,
  name text NOT NULL,
  email text,
  bot boolean NOT NULL DEFAULT false,
  person_id uuid REFERENCES entity (id) ON DELETE SET NULL
);

CREATE TABLE slack_message (
  entity_id uuid PRIMARY KEY REFERENCES entity (id) ON DELETE CASCADE,
  channel_id text NOT NULL REFERENCES slack_channel (id) ON DELETE CASCADE,
  ts text NOT NULL,
  thread_ts text,
  user_id text,
  mentions_me boolean NOT NULL DEFAULT false,
  sent_at timestamptz NOT NULL,
  UNIQUE (channel_id, ts)
);
CREATE INDEX slack_message_sent ON slack_message (sent_at DESC);
