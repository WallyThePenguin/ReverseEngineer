-- Jarvis fails loudly, then recovers (D54). A turn counts its attempts, says what kind of error
-- ended the last one, keeps the routine's plain fallback to publish if the model never manages,
-- and remembers that the owner pressed Stop, in case the Jarvis process missed the signal.
ALTER TABLE jarvis_turn ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE jarvis_turn ADD COLUMN error_kind text;
ALTER TABLE jarvis_turn ADD COLUMN fallback jsonb;
ALTER TABLE jarvis_turn ADD COLUMN cancel_requested_at timestamptz;

-- Jarvis's health is worked out from its latest finished turns.
CREATE INDEX jarvis_turn_finished ON jarvis_turn (finished_at DESC) WHERE finished_at IS NOT NULL;
