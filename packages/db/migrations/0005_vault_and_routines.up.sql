-- Jarvis's browser, steps 2 and 3 (B2): the sign-in vault (D26, D29) and your own routines.

-- Sign-ins Jarvis may use. The password is encrypted with a key kept outside the database
-- (HEARTH_VAULT_KEY, or vault.key in the data folder), so a copy of the database alone, or a
-- backup of it, doesn't give the passwords away. The model never sees them.
CREATE TABLE vault_login (
  id uuid PRIMARY KEY,
  site text NOT NULL,
  username text NOT NULL,
  secret text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  UNIQUE (site, username)
);

-- Things you asked Jarvis to do on a schedule, in your words. The schedule table times them.
CREATE TABLE routine (
  entity_id uuid PRIMARY KEY REFERENCES entity (id) ON DELETE CASCADE,
  instructions text NOT NULL,
  cron text NOT NULL,
  active boolean NOT NULL DEFAULT true
);
