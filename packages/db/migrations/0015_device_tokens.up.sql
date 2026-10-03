-- Desktop app (M3). Its token signs in as you but may only run the actions it needs (dictation
-- cleanup, voice commands, talking to Jarvis); null scopes is a full sign-in. Voice commands are
-- a new kind of Jarvis turn.
ALTER TABLE session ADD COLUMN scopes text[];

ALTER TABLE jarvis_turn DROP CONSTRAINT jarvis_turn_trigger_check;
ALTER TABLE jarvis_turn ADD CONSTRAINT jarvis_turn_trigger_check CHECK (trigger IN (
  'chat', 'mention', 'assignment', 'approval', 'watch', 'reflex', 'routine', 'voice_command'
));

-- A paired device can only read the conversations it started.
ALTER TABLE conversation ADD COLUMN started_via text;
