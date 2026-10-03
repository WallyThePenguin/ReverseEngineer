-- Live docs (M4). A note's text is a Loro CRDT, so every open screen and Jarvis edit the same
-- document and merge cleanly, even offline. The body column stays the readable copy everything
-- else uses. Updates are appended and folded into the snapshot from time to time; the snapshot
-- keeps the whole history, so nothing is lost by folding.
CREATE TABLE doc_state (
  entity_id uuid PRIMARY KEY REFERENCES entity (id) ON DELETE CASCADE,
  snapshot bytea NOT NULL,
  -- The last update folded into the snapshot.
  upto bigint NOT NULL DEFAULT 0,
  -- The record's revision when the body last matched the doc: a newer one means something
  -- wrote the body directly, and the doc takes that in as an edit.
  revision integer NOT NULL
);

CREATE TABLE doc_update (
  seq bigserial PRIMARY KEY,
  entity_id uuid NOT NULL REFERENCES entity (id) ON DELETE CASCADE,
  data bytea NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX doc_update_entity ON doc_update (entity_id, seq);
