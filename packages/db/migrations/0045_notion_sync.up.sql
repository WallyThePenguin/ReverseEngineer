-- Notion tasks (D68): the tickets assigned to you on one Notion task board come in as notion_task
-- records, read with an internal integration's token you paste in Settings. Hearth never writes
-- to Notion. Jarvis makes your Hearth tasks from them (the Jarvis lane's reflex).
UPDATE principal SET display_name = 'Notion' WHERE id = 'integration:notion';

CREATE TABLE notion_account (
  -- The integration's bot user, from /users/me.
  bot_id text PRIMARY KEY,
  workspace text,
  -- The integration's token, sealed (never stored or logged in the clear).
  token text NOT NULL,
  -- The task board read, and who you are in Notion (null until you pick them in Settings).
  source_id text,
  source_title text,
  owner_user_id text,
  owner_name text,
  -- Which columns say who a ticket is for, whether it's done and when it's due (notion/columns.ts).
  columns jsonb,
  -- null until a round has read the board once: the first round brings in open tickets quietly.
  synced_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sync_state text NOT NULL DEFAULT 'ok' CHECK (sync_state IN ('ok', 'failing', 'revoked')),
  failures integer NOT NULL DEFAULT 0,
  failing_since timestamptz
);

CREATE TABLE notion_task (
  entity_id uuid PRIMARY KEY REFERENCES entity (id) ON DELETE CASCADE,
  page_id text NOT NULL UNIQUE,
  source_id text NOT NULL,
  url text NOT NULL,
  status text,
  done boolean NOT NULL DEFAULT false,
  -- "2026-10-10" for a day, or an ISO time when the column has one.
  due_at text,
  due_is_date boolean NOT NULL DEFAULT false,
  -- Still assigned to you, as of the last full read of the board.
  assigned boolean NOT NULL DEFAULT true,
  -- Brought in quietly by the board's first read: not news for the brief.
  backfill boolean NOT NULL DEFAULT false,
  edited_at timestamptz NOT NULL
);
