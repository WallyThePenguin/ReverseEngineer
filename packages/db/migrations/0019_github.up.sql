-- GitHub (M7): pull requests that name a task (T-123) link to it and move it forward. Read with
-- your own token, sealed with the vault key; Hearth never writes to GitHub.
INSERT INTO principal (id, kind, display_name) VALUES ('integration:github', 'integration', 'GitHub');

CREATE TABLE github_account (
  login text PRIMARY KEY,
  -- A read-only personal access token, sealed (never stored or logged in the clear).
  token text NOT NULL,
  synced_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE github_repo (
  full_name text PRIMARY KEY,
  -- PRs updated after this were not looked at yet.
  seen_until timestamptz,
  polled_at timestamptz
);

CREATE TABLE github_pr (
  entity_id uuid PRIMARY KEY REFERENCES entity (id) ON DELETE CASCADE,
  repo text NOT NULL,
  number integer NOT NULL,
  url text NOT NULL,
  author text NOT NULL,
  head_ref text NOT NULL,
  state text NOT NULL CHECK (state IN ('open', 'draft', 'merged', 'closed')),
  updated_at timestamptz NOT NULL,
  UNIQUE (repo, number)
);
