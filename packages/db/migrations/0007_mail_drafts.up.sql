-- Email drafts (M2). The subject is the entity's title and the text its body. Sending one takes
-- your yes when Jarvis asks; once sent, the draft becomes the sent message.
CREATE TABLE mail_draft (
  entity_id uuid PRIMARY KEY REFERENCES entity (id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES mail_account (id) ON DELETE CASCADE,
  -- The conversation it answers, if it's a reply.
  thread_id uuid REFERENCES mail_thread (entity_id) ON DELETE SET NULL,
  to_addresses jsonb NOT NULL DEFAULT '[]',
  cc_addresses jsonb NOT NULL DEFAULT '[]',
  bcc_addresses jsonb NOT NULL DEFAULT '[]',
  in_reply_to text,
  refs text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX mail_draft_thread ON mail_draft (thread_id) WHERE thread_id IS NOT NULL;
