-- Mail (M2). Messages sync in from a provider (Gmail first, D15) and are threaded by their RFC
-- headers, so any provider threads the same way. The raw message is kept on disk by its hash;
-- these tables hold what the app and Jarvis read.
CREATE TABLE mail_account (
  id text PRIMARY KEY,
  provider text NOT NULL,
  address text NOT NULL,
  -- Where the next sync starts: the provider's own bookmark, as JSON.
  cursor jsonb,
  synced_at timestamptz,
  last_error text,
  UNIQUE (provider, address)
);

-- One row per conversation. Its title (the subject) lives on the entity.
CREATE TABLE mail_thread (
  entity_id uuid PRIMARY KEY REFERENCES entity (id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES mail_account (id) ON DELETE CASCADE,
  -- The Message-ID the conversation started from.
  root_message_id text NOT NULL,
  snippet text NOT NULL DEFAULT '',
  participants jsonb NOT NULL DEFAULT '[]',
  last_message_at timestamptz NOT NULL,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  message_count integer NOT NULL DEFAULT 0,
  unread boolean NOT NULL DEFAULT false,
  starred boolean NOT NULL DEFAULT false,
  in_inbox boolean NOT NULL DEFAULT false,
  trashed boolean NOT NULL DEFAULT false,
  lane text NOT NULL DEFAULT 'signal' CHECK (lane IN ('signal', 'noise')),
  UNIQUE (account_id, root_message_id)
);
CREATE INDEX mail_thread_recent ON mail_thread (last_message_at DESC);

-- One row per message. Its subject is the entity's title and its plain text the entity's body.
CREATE TABLE mail_message (
  entity_id uuid PRIMARY KEY REFERENCES entity (id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES mail_thread (entity_id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES mail_account (id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  message_id text NOT NULL,
  in_reply_to text,
  refs text[] NOT NULL DEFAULT '{}',
  from_address text NOT NULL DEFAULT '',
  from_name text,
  to_addresses jsonb NOT NULL DEFAULT '[]',
  cc_addresses jsonb NOT NULL DEFAULT '[]',
  reply_to text,
  sent_at timestamptz NOT NULL,
  -- The provider's flags, in Gmail's words: INBOX, UNREAD, STARRED, TRASH, SENT, CATEGORY_...
  labels text[] NOT NULL DEFAULT '{}',
  outbound boolean NOT NULL DEFAULT false,
  raw_hash text NOT NULL,
  has_html boolean NOT NULL DEFAULT false,
  attachments jsonb NOT NULL DEFAULT '[]',
  snippet text NOT NULL DEFAULT '',
  UNIQUE (account_id, provider_id)
);
CREATE INDEX mail_message_rfc ON mail_message (account_id, message_id);
CREATE INDEX mail_message_thread ON mail_message (thread_id, sent_at);

-- Archiving, starring and the like happen in Hearth at once; these wait to reach the provider.
-- `undo` holds each message's flags from before, to roll back if the provider refuses.
CREATE TABLE mail_op (
  id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES mail_account (id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES mail_thread (entity_id) ON DELETE CASCADE,
  provider_ids text[] NOT NULL,
  add_labels text[] NOT NULL DEFAULT '{}',
  remove_labels text[] NOT NULL DEFAULT '{}',
  undo jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Your Signal and Noise choices: an address ("news@shop.example") or a whole domain ("shop.example").
CREATE TABLE mail_sender_rule (
  pattern text PRIMARY KEY,
  lane text NOT NULL CHECK (lane IN ('signal', 'noise')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Which person an email address belongs to.
CREATE TABLE person_email (
  address text PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES entity (id) ON DELETE CASCADE
);
CREATE INDEX person_email_person ON person_email (person_id);
