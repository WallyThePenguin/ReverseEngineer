DROP TABLE slack_message;
DROP TABLE slack_user;
DROP TABLE slack_channel;
DROP TABLE slack_workspace;
DELETE FROM entity WHERE type = 'slack_message';
DELETE FROM principal WHERE id = 'integration:slack';
