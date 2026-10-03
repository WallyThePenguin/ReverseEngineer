-- Canvas boards (M7). The board itself is JSON in Macro's block-canvas shape; the entity's body
-- is the board as markdown, so search, backlinks and Jarvis read it like a note. Last write wins
-- (D20); version counts the saves.
CREATE TABLE canvas_board (
  entity_id uuid PRIMARY KEY REFERENCES entity(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
  version integer NOT NULL DEFAULT 0
);
