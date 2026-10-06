-- When Jarvis last wrote a draft in a conversation. It stays when you throw the draft away, so the
-- morning's reply drafting doesn't write again what you discarded, until another message arrives.
ALTER TABLE mail_thread ADD COLUMN drafted_at timestamptz;
