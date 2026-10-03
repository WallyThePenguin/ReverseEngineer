-- Meeting notes (M5). A meeting is your notes, the transcript and Jarvis's summary for one
-- conversation, linked to its calendar event and the people in it. Transcript segments have ids
-- the recorder derives from the audio (channel and start), so sending them again never duplicates.
CREATE TABLE meeting (
  entity_id uuid PRIMARY KEY REFERENCES entity (id) ON DELETE CASCADE,
  event_id uuid REFERENCES entity (id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  summary text,
  summarized_at timestamptz
);
CREATE UNIQUE INDEX meeting_event ON meeting (event_id);

CREATE TABLE meeting_segment (
  meeting_id uuid NOT NULL REFERENCES entity (id) ON DELETE CASCADE,
  id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('me', 'them')),
  start_ms integer NOT NULL,
  end_ms integer NOT NULL,
  text text NOT NULL,
  PRIMARY KEY (meeting_id, id)
);
CREATE INDEX meeting_segment_order ON meeting_segment (meeting_id, start_ms);
