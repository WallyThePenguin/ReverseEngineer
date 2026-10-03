-- Google accounts and Calendar sync (M1). Tokens stay on this PC, in this database, and in its
-- encrypted backups.
CREATE TABLE google_account (
  email text PRIMARY KEY,
  refresh_token text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  access_token text,
  access_expires_at timestamptz,
  connected_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'failing', 'revoked')),
  last_error text
);

-- A sign-in in progress: the state and PKCE verifier, kept for ten minutes.
CREATE TABLE oauth_state (
  state text PRIMARY KEY,
  verifier text NOT NULL,
  scopes text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE calendar (
  id text PRIMARY KEY,
  account text NOT NULL REFERENCES google_account (email) ON DELETE CASCADE,
  title text NOT NULL,
  color text,
  time_zone text,
  is_primary boolean NOT NULL DEFAULT false,
  can_write boolean NOT NULL DEFAULT false,
  selected boolean NOT NULL DEFAULT true,
  last_synced_at timestamptz,
  last_error text
);

-- One row per Google event (each occurrence of a repeating event is its own row). The title
-- and description live on the entity.
CREATE TABLE calendar_event (
  entity_id uuid PRIMARY KEY REFERENCES entity (id) ON DELETE CASCADE,
  calendar_id text NOT NULL REFERENCES calendar (id) ON DELETE CASCADE,
  google_id text NOT NULL,
  etag text,
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'tentative', 'cancelled')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  all_day boolean NOT NULL DEFAULT false,
  location text,
  meet_url text,
  html_link text,
  busy boolean NOT NULL DEFAULT true,
  organizer text,
  self_organizer boolean NOT NULL DEFAULT true,
  self_response text,
  attendees jsonb NOT NULL DEFAULT '[]',
  recurring_event_id text,
  -- A time block Hearth put on your calendar for a task.
  task_id uuid REFERENCES entity (id) ON DELETE SET NULL,
  UNIQUE (calendar_id, google_id)
);
CREATE INDEX calendar_event_time ON calendar_event (starts_at, ends_at) WHERE status <> 'cancelled';
CREATE INDEX calendar_event_task ON calendar_event (task_id) WHERE task_id IS NOT NULL;

-- Records synced in from Google are written as Google, so Jarvis treats their text as outside
-- content (D25).
INSERT INTO principal (id, kind, display_name) VALUES ('integration:google', 'integration', 'Google');
