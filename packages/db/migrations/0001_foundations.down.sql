DROP TABLE IF EXISTS watch, schedule, heartbeat_item, observation, jarvis_turn, conversation_log, conversation,
  setting, auth_challenge, session, credential, audit, notification, standing_rule, approval,
  consumer_cursor CASCADE;
DROP TRIGGER IF EXISTS event_notify ON event;
DROP FUNCTION IF EXISTS event_notify();
DROP TABLE IF EXISTS event, task, property, property_def, link CASCADE;
ALTER TABLE principal DROP CONSTRAINT IF EXISTS principal_entity_fk;
DROP TABLE IF EXISTS entity, principal CASCADE;
