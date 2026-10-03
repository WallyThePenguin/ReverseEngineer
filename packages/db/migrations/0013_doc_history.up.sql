-- Doc history (M4). The Loro doc already keeps every edit; these say who made them and name the
-- points you want to come back to.
-- Who each Loro peer (one screen's or one server edit's id) wrote as. The first claim stands.
CREATE TABLE doc_peer (
  entity_id uuid NOT NULL REFERENCES entity (id) ON DELETE CASCADE,
  peer text NOT NULL,
  principal text NOT NULL,
  PRIMARY KEY (entity_id, peer)
);

-- Named checkpoints: a doc's version (Loro frontiers) under a name.
CREATE TABLE doc_checkpoint (
  id uuid PRIMARY KEY,
  entity_id uuid NOT NULL REFERENCES entity (id) ON DELETE CASCADE,
  name text NOT NULL,
  frontiers jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX doc_checkpoint_entity ON doc_checkpoint (entity_id, created_at);
