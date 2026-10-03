DELETE FROM jarvis_turn WHERE trigger = 'voice_command';
ALTER TABLE jarvis_turn DROP CONSTRAINT jarvis_turn_trigger_check;
ALTER TABLE jarvis_turn ADD CONSTRAINT jarvis_turn_trigger_check CHECK (trigger IN (
  'chat', 'mention', 'assignment', 'approval', 'watch', 'reflex', 'routine'
));
ALTER TABLE session DROP COLUMN IF EXISTS scopes;
