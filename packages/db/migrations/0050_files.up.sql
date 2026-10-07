-- Files you add to Hearth (pasted, dropped or uploaded). Each is a record of type "file", named
-- for the file; its bytes are kept once, by their SHA-256, in the data folder's blobs beside
-- mail's originals. Trashing one keeps its bytes, so it can come back, and mail's sweep keeps
-- the bytes of every row here.
CREATE TABLE stored_file (
  entity_id uuid PRIMARY KEY REFERENCES entity(id) ON DELETE CASCADE,
  hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  mime text NOT NULL,
  size integer NOT NULL CHECK (size > 0)
);
CREATE INDEX stored_file_hash_idx ON stored_file (hash);
