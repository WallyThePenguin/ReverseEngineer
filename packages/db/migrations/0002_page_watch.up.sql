-- Page watches (B1): a web page Hearth checks on a schedule, in your Chrome or with a plain fetch.
-- The page's text is kept so a change can be shown; it's outside content, so reading it lowers
-- Jarvis's trust for the rest of a turn (D25).
CREATE TABLE page_watch (
  entity_id uuid PRIMARY KEY REFERENCES entity (id) ON DELETE CASCADE,
  url text NOT NULL,
  mode text NOT NULL DEFAULT 'browser' CHECK (mode IN ('browser', 'fetch')),
  selector text,
  every_minutes integer NOT NULL DEFAULT 60 CHECK (every_minutes >= 15),
  then_ask text,
  active boolean NOT NULL DEFAULT true,
  next_check_at timestamptz,
  last_checked_at timestamptz,
  last_changed_at timestamptz,
  last_text text,
  previous_text text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'ok', 'waiting', 'failing')),
  last_error text,
  failures integer NOT NULL DEFAULT 0
);
CREATE INDEX page_watch_due ON page_watch (next_check_at) WHERE active;
