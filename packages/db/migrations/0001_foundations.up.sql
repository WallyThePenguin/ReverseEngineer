-- Hearth foundations: the graph, the event log, the inbox, approvals, auth and Jarvis's spine.
-- See PLAN.md sections 5.3 to 5.5 and 6.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Who can act: you, Jarvis, the system, each MCP client and each integration.
CREATE TABLE principal (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('owner', 'agent', 'mcp_client', 'integration', 'system')),
  display_name text NOT NULL,
  entity_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);

-- One row per node in the graph. Module tables hang off entity.id.
CREATE TABLE entity (
  id uuid PRIMARY KEY,
  type text NOT NULL,
  title text NOT NULL DEFAULT '',
  -- Markdown with <m-ref> mention tags: the stored form for notes, tasks and comments, and the
  -- text projection of everything else (search and Jarvis read this).
  body text,
  -- Container: the item a comment belongs to, a subtask's parent, a message's channel.
  parent_id uuid REFERENCES entity (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL REFERENCES principal (id),
  updated_by text NOT NULL REFERENCES principal (id),
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1,
  search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', regexp_replace(coalesce(body, ''), '<[^>]*>', ' ', 'g')), 'B')
  ) STORED
);
CREATE INDEX entity_type_recent ON entity (type, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX entity_parent ON entity (parent_id, created_at) WHERE parent_id IS NOT NULL;
CREATE INDEX entity_search ON entity USING gin (search);
CREATE INDEX entity_title_trgm ON entity USING gin (title gin_trgm_ops);

ALTER TABLE principal ADD CONSTRAINT principal_entity_fk FOREIGN KEY (entity_id) REFERENCES entity (id);

-- The graph. Backlinks are one indexed query on to_id.
CREATE TABLE link (
  id uuid PRIMARY KEY,
  from_id uuid NOT NULL REFERENCES entity (id) ON DELETE CASCADE,
  to_id uuid NOT NULL REFERENCES entity (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (
    'mention', 'attachment', 'property_ref', 'reply', 'derived_from', 'participant', 'related'
  )),
  -- Where in the source the link sits: '#0', '#1' for the nth mention of the same target.
  anchor text NOT NULL DEFAULT '',
  created_by text NOT NULL REFERENCES principal (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_id, to_id, kind, anchor)
);
CREATE INDEX link_to ON link (to_id, kind);

-- Typed custom fields on any entity type. System properties are seeded at fixed IDs.
CREATE TABLE property_def (
  id uuid PRIMARY KEY,
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  value_type text NOT NULL CHECK (value_type IN (
    'text', 'number', 'boolean', 'date', 'datetime', 'select', 'multi_select', 'entity_ref'
  )),
  options jsonb,
  applies_to text[] NOT NULL DEFAULT '{}',
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE property (
  entity_id uuid NOT NULL REFERENCES entity (id) ON DELETE CASCADE,
  def_id uuid NOT NULL REFERENCES property_def (id) ON DELETE CASCADE,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL REFERENCES principal (id),
  PRIMARY KEY (entity_id, def_id)
);
CREATE INDEX property_def_value ON property (def_id, value);

-- Tasks: an entity with a markdown body plus typed columns.
CREATE SEQUENCE task_number_seq;
CREATE TABLE task (
  entity_id uuid PRIMARY KEY REFERENCES entity (id) ON DELETE CASCADE,
  number integer NOT NULL UNIQUE DEFAULT nextval('task_number_seq'),
  status text NOT NULL DEFAULT 'not_started' CHECK (status IN (
    'not_started', 'in_progress', 'in_review', 'completed', 'canceled'
  )),
  priority text NOT NULL DEFAULT 'none' CHECK (priority IN ('none', 'low', 'medium', 'high', 'urgent')),
  due_at timestamptz,
  due_is_date boolean NOT NULL DEFAULT false,
  estimate_minutes integer CHECK (estimate_minutes IS NULL OR estimate_minutes > 0),
  assignee text REFERENCES principal (id),
  project_id uuid REFERENCES entity (id) ON DELETE SET NULL,
  completed_at timestamptz
);
ALTER SEQUENCE task_number_seq OWNED BY task.number;
CREATE INDEX task_open_due ON task (due_at) WHERE status NOT IN ('completed', 'canceled');
CREATE INDEX task_open_assignee ON task (assignee) WHERE status NOT IN ('completed', 'canceled');

-- The append-only event log. Writers take an advisory lock before inserting, so seq order is
-- commit order and a consumer reading "seq > cursor" never skips an event.
CREATE TABLE event (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  entity_id uuid,
  actor text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('owner', 'agent', 'untrusted', 'system')),
  payload jsonb NOT NULL DEFAULT '{}',
  correlation_id uuid,
  causation_id uuid
);
CREATE INDEX event_entity ON event (entity_id, seq) WHERE entity_id IS NOT NULL;
CREATE INDEX event_kind ON event (kind, seq);

CREATE FUNCTION event_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('hearth_event', NEW.seq::text);
  RETURN NULL;
END
$$;
CREATE TRIGGER event_notify AFTER INSERT ON event FOR EACH ROW EXECUTE FUNCTION event_notify();

CREATE TABLE consumer_cursor (
  consumer text PRIMARY KEY,
  seq bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Things waiting on you or Jarvis's say-so.
CREATE TABLE approval (
  id uuid PRIMARY KEY,
  action text NOT NULL,
  input jsonb NOT NULL,
  input_hash text NOT NULL,
  risk text NOT NULL,
  summary text NOT NULL,
  reason text NOT NULL,
  requested_by text NOT NULL REFERENCES principal (id),
  origin text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'denied', 'executed', 'failed', 'expired'
  )),
  decided_by text REFERENCES principal (id),
  decided_at timestamptz,
  result jsonb,
  error text,
  turn_id uuid,
  conversation_id uuid,
  correlation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);
CREATE INDEX approval_pending ON approval (created_at) WHERE status = 'pending';

-- Your written exceptions: "Jarvis may do X without asking".
CREATE TABLE standing_rule (
  id uuid PRIMARY KEY,
  action text NOT NULL,
  principal text NOT NULL REFERENCES principal (id),
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (action, principal)
);

-- The inbox. One row per thing that needs you; the inbox shows the live ones.
CREATE TABLE notification (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  title text NOT NULL,
  body text,
  entity_id uuid REFERENCES entity (id) ON DELETE CASCADE,
  approval_id uuid REFERENCES approval (id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'unseen' CHECK (state IN ('unseen', 'seen', 'done')),
  lane text NOT NULL DEFAULT 'signal' CHECK (lane IN ('signal', 'noise')),
  urgency text NOT NULL DEFAULT 'normal' CHECK (urgency IN ('interrupt', 'normal', 'quiet')),
  deadline timestamptz,
  delivered_at timestamptz,
  deferred_reason text,
  snoozed_until timestamptz,
  dedupe_key text UNIQUE,
  source_event_seq bigint,
  created_by text NOT NULL REFERENCES principal (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_live ON notification (created_at DESC) WHERE state <> 'done';

-- One row per action call, from any surface.
CREATE TABLE audit (
  id uuid PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  principal text NOT NULL,
  origin text NOT NULL,
  via text NOT NULL,
  action text NOT NULL,
  risk text NOT NULL,
  input jsonb,
  outcome text NOT NULL CHECK (outcome IN ('ok', 'error', 'pending_approval', 'denied')),
  error text,
  duration_ms integer NOT NULL DEFAULT 0,
  correlation_id uuid,
  approval_id uuid
);
CREATE INDEX audit_recent ON audit (at DESC);
CREATE INDEX audit_principal ON audit (principal, at DESC);

-- Login: passkeys for you, hashed bearer tokens for sessions and API clients.
CREATE TABLE credential (
  id text PRIMARY KEY,
  principal text NOT NULL REFERENCES principal (id),
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[] NOT NULL DEFAULT '{}',
  label text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE TABLE session (
  token_hash text PRIMARY KEY,
  principal text NOT NULL REFERENCES principal (id),
  kind text NOT NULL CHECK (kind IN ('browser', 'api')),
  label text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE auth_challenge (
  id text PRIMARY KEY,
  challenge text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('register', 'login')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE setting (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Jarvis conversations are entities (type 'conversation'); each is an append-only log rendered
-- by a pure fold, so a live stream and a reload look the same.
CREATE TABLE conversation (
  entity_id uuid PRIMARY KEY REFERENCES entity (id) ON DELETE CASCADE,
  -- The item a thread conversation is about (a note Jarvis was @mentioned in, a task it works).
  subject_id uuid REFERENCES entity (id) ON DELETE SET NULL,
  agent_session_id text,
  last_turn_at timestamptz
);
CREATE UNIQUE INDEX conversation_subject ON conversation (subject_id) WHERE subject_id IS NOT NULL;

CREATE TABLE conversation_log (
  conversation_id uuid NOT NULL REFERENCES entity (id) ON DELETE CASCADE,
  idx integer NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  turn_id uuid,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (conversation_id, idx)
);

-- Every Jarvis turn: queued by a trigger, claimed by the Jarvis service, audited when done.
CREATE TABLE jarvis_turn (
  id uuid PRIMARY KEY,
  trigger text NOT NULL CHECK (trigger IN (
    'chat', 'mention', 'assignment', 'approval', 'watch', 'reflex', 'routine'
  )),
  mode text NOT NULL CHECK (mode IN ('reactive', 'proactive')),
  lane text NOT NULL CHECK (lane IN ('fast', 'deep')),
  origin text NOT NULL,
  prompt text NOT NULL,
  context jsonb NOT NULL DEFAULT '{}',
  conversation_id uuid REFERENCES entity (id) ON DELETE SET NULL,
  subject_id uuid REFERENCES entity (id) ON DELETE SET NULL,
  source_event_seq bigint,
  dedupe_key text UNIQUE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'running', 'done', 'failed', 'skipped', 'canceled'
  )),
  skip_reason text,
  outcome text CHECK (outcome IN ('act', 'ask', 'tell', 'note', 'nothing')),
  reply text,
  tools_used text[] NOT NULL DEFAULT '{}',
  writes integer NOT NULL DEFAULT 0,
  error text,
  queued_at timestamptz NOT NULL DEFAULT now(),
  not_before timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  first_token_ms integer,
  duration_ms integer
);
CREATE INDEX jarvis_turn_queue ON jarvis_turn (not_before, queued_at) WHERE status = 'queued';
CREATE INDEX jarvis_turn_recent ON jarvis_turn (queued_at DESC);

-- Side findings saved for the brief, never sent as messages.
CREATE TABLE observation (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('finding', 'risk', 'followup', 'fyi')),
  text text NOT NULL,
  about_id uuid REFERENCES entity (id) ON DELETE SET NULL,
  supersedes uuid REFERENCES observation (id) ON DELETE SET NULL,
  expires_at timestamptz,
  surfaced_at timestamptz,
  created_by text NOT NULL REFERENCES principal (id),
  turn_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX observation_open ON observation (created_at) WHERE surfaced_at IS NULL;

-- Small things reflexes set aside for the next heartbeat, so many minor events cost one turn.
CREATE TABLE heartbeat_item (
  id uuid PRIMARY KEY,
  text text NOT NULL,
  about_id uuid REFERENCES entity (id) ON DELETE SET NULL,
  source_event_seq bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  taken_at timestamptz
);
CREATE INDEX heartbeat_item_open ON heartbeat_item (created_at) WHERE taken_at IS NULL;

-- One scheduler for routines, reminders and watch expiry. A firing appends a clock.fired event
-- in the same transaction that advances next_run_at, so each firing happens exactly once.
CREATE TABLE schedule (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('routine', 'reminder', 'check')),
  cron text,
  time_zone text NOT NULL DEFAULT 'America/New_York',
  next_run_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}',
  stale_after_seconds integer,
  enabled boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  last_outcome text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX schedule_due ON schedule (next_run_at) WHERE enabled AND next_run_at IS NOT NULL;

-- Things Jarvis was asked to keep an eye on: a saved filter over events, with an expiry.
CREATE TABLE watch (
  id uuid PRIMARY KEY,
  description text NOT NULL,
  filter jsonb NOT NULL,
  subject_id uuid REFERENCES entity (id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES entity (id) ON DELETE SET NULL,
  created_by text NOT NULL REFERENCES principal (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  last_matched_at timestamptz,
  ended_at timestamptz
);
CREATE INDEX watch_active ON watch (created_at) WHERE ended_at IS NULL;

-- Seeds: you, Jarvis and the system.
INSERT INTO principal (id, kind, display_name) VALUES
  ('owner', 'owner', 'You'),
  ('jarvis', 'agent', 'Jarvis'),
  ('system', 'system', 'Hearth');

INSERT INTO entity (id, type, title, created_by, updated_by) VALUES
  ('00000000-0000-4000-8000-000000000001', 'person', 'You', 'system', 'system'),
  ('00000000-0000-4000-8000-000000000002', 'agent', 'Jarvis', 'system', 'system');

UPDATE principal SET entity_id = '00000000-0000-4000-8000-000000000001' WHERE id = 'owner';
UPDATE principal SET entity_id = '00000000-0000-4000-8000-000000000002' WHERE id = 'jarvis';

INSERT INTO property_def (id, key, name, value_type, is_system) VALUES
  ('00000000-0000-4000-9000-000000000001', 'tags', 'Tags', 'multi_select', true);
