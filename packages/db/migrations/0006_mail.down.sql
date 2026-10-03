DROP TABLE IF EXISTS person_email;
DROP TABLE IF EXISTS mail_sender_rule;
DROP TABLE IF EXISTS mail_op;
DELETE FROM entity WHERE type IN ('email', 'email_thread');
DROP TABLE IF EXISTS mail_message;
DROP TABLE IF EXISTS mail_thread;
DROP TABLE IF EXISTS mail_account;
