-- What Jarvis does on its own to your calendar can be undone from its line in the inbox (D71,
-- D72). The undo is a closed shape ({kind, eventId, before}) that the server maps to one exact
-- action; only the calendar's own code writes it, never an action's input.
ALTER TABLE notification ADD COLUMN undo jsonb;

-- A meeting Jarvis accepted (D71). Its guests don't become people, so "someone you know" grows
-- only through your own yes or your own mail, never through an invitation Jarvis answered.
ALTER TABLE calendar_event ADD COLUMN jarvis_accepted boolean NOT NULL DEFAULT false;
