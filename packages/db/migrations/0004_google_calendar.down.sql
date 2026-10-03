DELETE FROM entity WHERE type = 'event';
DROP TABLE IF EXISTS calendar_event;
DROP TABLE IF EXISTS calendar;
DROP TABLE IF EXISTS oauth_state;
DROP TABLE IF EXISTS google_account;
DELETE FROM principal WHERE id = 'integration:google';
