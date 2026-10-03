-- Jarvis's memory (M1): notes about you and your work that every turn can draw on. The text
-- lives on the entity; this table says when a note is used, and every version is kept so a
-- change can be reviewed and undone.
CREATE TABLE memory_note (
  entity_id uuid PRIMARY KEY REFERENCES entity (id) ON DELETE CASCADE,
  -- always: in every turn. topic: only when one of its keywords comes up.
  scope text NOT NULL DEFAULT 'topic' CHECK (scope IN ('always', 'topic')),
  keywords text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE memory_revision (
  entity_id uuid NOT NULL REFERENCES entity (id) ON DELETE CASCADE,
  revision integer NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  scope text NOT NULL,
  keywords text[] NOT NULL DEFAULT '{}',
  reason text,
  changed_by text NOT NULL REFERENCES principal (id),
  turn_id uuid,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_id, revision)
);
CREATE INDEX memory_revision_recent ON memory_revision (at DESC);
