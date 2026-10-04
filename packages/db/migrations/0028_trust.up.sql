-- Approvals happen once; outside text stays outside (D58).

-- A yes claims its approval before the action runs ('executing'), so a second yes, from another
-- tab or the phone, finds it taken instead of running it again.
ALTER TABLE approval DROP CONSTRAINT approval_status_check;
ALTER TABLE approval ADD CONSTRAINT approval_status_check CHECK (status IN (
  'pending', 'executing', 'denied', 'executed', 'failed', 'expired'
));

-- The same request from the same asker waits once. Copies already waiting keep the oldest.
WITH copies AS (
  UPDATE approval a SET status = 'expired', error = 'The same request was already waiting.'
  WHERE a.status = 'pending' AND EXISTS (
    SELECT 1 FROM approval b
    WHERE b.status = 'pending' AND b.action = a.action AND b.input_hash = a.input_hash
      AND b.requested_by = a.requested_by AND (b.created_at, b.id) < (a.created_at, a.id)
  )
  RETURNING a.id
)
UPDATE notification SET state = 'done', updated_at = now()
WHERE approval_id IN (SELECT id FROM copies);
CREATE UNIQUE INDEX approval_waiting_once ON approval (action, input_hash, requested_by)
  WHERE status = 'pending';

-- Every approval runs out. Those already waiting get a day from now.
UPDATE approval SET expires_at = now() + interval '1 day'
WHERE status = 'pending' AND expires_at IS NULL;
CREATE INDEX approval_expiring ON approval (expires_at) WHERE status IN ('pending', 'executing');

-- Once a conversation has read outside content, its later turns start untrusted, with the
-- addresses it saw and the sites it opened before then (D25, D30).
ALTER TABLE conversation ADD COLUMN tainted_at timestamptz;
ALTER TABLE conversation ADD COLUMN taint_source text;
ALTER TABLE conversation ADD COLUMN seen_urls text[] NOT NULL DEFAULT '{}';
ALTER TABLE conversation ADD COLUMN vouched_hosts text[] NOT NULL DEFAULT '{}';

-- Text kept for later turns says how far it can be trusted. Rows from before this are unknown,
-- so they count as outside content.
ALTER TABLE watch ADD COLUMN origin text NOT NULL DEFAULT 'untrusted';
ALTER TABLE observation ADD COLUMN origin text NOT NULL DEFAULT 'untrusted';
ALTER TABLE heartbeat_item ADD COLUMN origin text NOT NULL DEFAULT 'untrusted';
-- Except watches you set up yourself.
UPDATE watch SET origin = 'owner' WHERE created_by = 'owner';

-- A record whose text was written after reading outside content (Jarvis's journal, a task it
-- made from an email) is outside content too. Outside tools' records are known by their author;
-- the rest are found from the event log: created, or its text changed, by an untrusted caller.
ALTER TABLE entity ADD COLUMN outside boolean NOT NULL DEFAULT false;
UPDATE entity e SET outside = true
WHERE e.created_by NOT LIKE 'integration:%' AND e.created_by NOT LIKE 'mcp:%'
  AND EXISTS (
    SELECT 1 FROM event v
    WHERE v.entity_id = e.id AND v.origin = 'untrusted'
      AND (v.kind = 'entity.created'
        OR (v.kind = 'entity.updated' AND v.payload->'changed' ?| array['title', 'body']))
  );
