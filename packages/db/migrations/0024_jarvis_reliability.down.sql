DROP INDEX jarvis_turn_finished;
ALTER TABLE jarvis_turn DROP COLUMN cancel_requested_at;
ALTER TABLE jarvis_turn DROP COLUMN fallback;
ALTER TABLE jarvis_turn DROP COLUMN error_kind;
ALTER TABLE jarvis_turn DROP COLUMN attempts;
