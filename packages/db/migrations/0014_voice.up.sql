-- Voice (M3). Every dictation is a record you can search, fix and use again; fixing one teaches
-- the dictionary. Snippets are records too (title: what you say, body: what's typed). Styles per
-- app are a setting.
CREATE TABLE dictation (
  entity_id uuid PRIMARY KEY REFERENCES entity (id) ON DELETE CASCADE,
  -- What the speech engine heard, before cleanup.
  raw text NOT NULL,
  app text,
  window_title text,
  style text,
  duration_ms integer,
  -- How long cleanup took, and whether the local model got to it in time.
  cleanup_ms integer NOT NULL,
  polished boolean NOT NULL DEFAULT false
);

CREATE TABLE dictionary_entry (
  id uuid PRIMARY KEY,
  -- What the engine hears, or null for a term the cleanup model should prefer as written.
  heard text,
  write text NOT NULL,
  -- Learned from a fix you made in the dictation history, rather than added by hand.
  learned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX dictionary_heard ON dictionary_entry (lower(heard)) WHERE heard IS NOT NULL;
CREATE UNIQUE INDEX dictionary_term ON dictionary_entry (lower(write)) WHERE heard IS NULL;
