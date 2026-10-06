-- Back to before D62. What member principals wrote goes first (the messages they left you, their
-- conversations with Jarvis, their held replies and standing rules), then the principals, so
-- nothing is left that only a member principal could have written.
CREATE TEMP TABLE member_principal ON COMMIT DROP AS
  SELECT id FROM principal WHERE kind = 'member';

DELETE FROM entity WHERE type = 'slack_member_message';
DELETE FROM entity WHERE id IN (
  SELECT entity_id FROM conversation WHERE started_via = 'slack_member'
);
DELETE FROM entity WHERE created_by IN (SELECT id FROM member_principal);
-- A member never edits your records, but should one have, it was last touched by its author.
UPDATE entity SET updated_by = created_by WHERE updated_by IN (SELECT id FROM member_principal);
DELETE FROM link WHERE created_by IN (SELECT id FROM member_principal);
DELETE FROM property WHERE updated_by IN (SELECT id FROM member_principal);
UPDATE task SET assignee = NULL WHERE assignee IN (SELECT id FROM member_principal);
-- Their inbox cards go with them.
DELETE FROM approval WHERE requested_by IN (SELECT id FROM member_principal);
UPDATE approval SET decided_by = NULL WHERE decided_by IN (SELECT id FROM member_principal);
DELETE FROM notification WHERE created_by IN (SELECT id FROM member_principal);
DELETE FROM standing_rule WHERE principal IN (SELECT id FROM member_principal);
DELETE FROM observation WHERE created_by IN (SELECT id FROM member_principal);
DELETE FROM watch WHERE created_by IN (SELECT id FROM member_principal);
DELETE FROM memory_revision WHERE changed_by IN (SELECT id FROM member_principal);
DELETE FROM session WHERE principal IN (SELECT id FROM member_principal);
DELETE FROM credential WHERE principal IN (SELECT id FROM member_principal);
DELETE FROM jarvis_turn WHERE trigger = 'slack_member';

DROP TABLE slack_outbox;
DROP TABLE slack_inbound;
DROP TABLE slack_thread;
DROP TABLE slack_answer;
DROP TABLE slack_bot;
ALTER TABLE slack_channel
  DROP CONSTRAINT slack_channel_jarvis_where,
  DROP COLUMN jarvis_tier, DROP COLUMN jarvis_replies, DROP COLUMN jarvis_checked_at;
ALTER TABLE slack_user
  DROP COLUMN principal, DROP COLUMN tier, DROP COLUMN replies, DROP COLUMN vip,
  DROP COLUMN guest, DROP COLUMN external, DROP COLUMN deleted, DROP COLUMN checked_at;

DELETE FROM principal WHERE id IN (SELECT id FROM member_principal);
ALTER TABLE principal DROP CONSTRAINT principal_kind_check;
ALTER TABLE principal ADD CONSTRAINT principal_kind_check CHECK (kind IN (
  'owner', 'agent', 'mcp_client', 'integration', 'system'
));

DROP INDEX jarvis_turn_trigger;
ALTER TABLE jarvis_turn DROP CONSTRAINT jarvis_turn_trigger_check;
ALTER TABLE jarvis_turn ADD CONSTRAINT jarvis_turn_trigger_check CHECK (trigger IN (
  'chat', 'mention', 'assignment', 'approval', 'watch', 'reflex', 'routine', 'voice_command'
));
