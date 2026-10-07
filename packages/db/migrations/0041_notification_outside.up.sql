-- An inbox item whose words came from outside content (an email, a message, a reminder set after
-- reading one): reading it back makes a turn careful, as reading the content itself would.
ALTER TABLE notification ADD COLUMN outside boolean NOT NULL DEFAULT false;
