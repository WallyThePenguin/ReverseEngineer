-- An email's fingerprint (6.9): a hash of its Message-ID, From, To, Cc, Reply-To, Subject, Date as
-- sent (to the millisecond) and body. The same email delivered to two of your accounts has the
-- same one and shows once; anything else, even reusing its Message-ID, is another email. Mail
-- saved before this has none, so it's never taken for a copy.
ALTER TABLE mail_message ADD COLUMN copy_key text;
