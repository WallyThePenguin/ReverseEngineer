-- Data connectors (D73): outside data Jarvis may read, connected in Settings, a Convex
-- deployment first. "read": Jarvis only reads. "approve_writes": changes too, each on your yes.
CREATE TABLE data_source (
  id uuid PRIMARY KEY,
  -- Your name for it, as Jarvis and you call it.
  label text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('convex')),
  mode text NOT NULL DEFAULT 'read' CHECK (mode IN ('read', 'approve_writes')),
  -- Where it is: a Convex deployment's URL. Not a secret.
  address text NOT NULL,
  -- The key Hearth uses there, sealed (never stored or logged in the clear).
  secret text NOT NULL,
  -- What the key is, in plain words for Settings ("production deploy key").
  key_kind text NOT NULL,
  -- When the key last worked, and what kept it from working, if anything.
  checked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
