ALTER TABLE entity DROP COLUMN outside;

ALTER TABLE heartbeat_item DROP COLUMN origin;
ALTER TABLE observation DROP COLUMN origin;
ALTER TABLE watch DROP COLUMN origin;

ALTER TABLE conversation DROP COLUMN vouched_hosts;
ALTER TABLE conversation DROP COLUMN seen_urls;
ALTER TABLE conversation DROP COLUMN taint_source;
ALTER TABLE conversation DROP COLUMN tainted_at;

DROP INDEX approval_expiring;
DROP INDEX approval_waiting_once;
-- One cut short mid-run can't be told apart from a failure by the older code.
UPDATE approval SET status = 'failed', error = 'Hearth was rolled back while this was running.'
WHERE status = 'executing';
ALTER TABLE approval DROP CONSTRAINT approval_status_check;
ALTER TABLE approval ADD CONSTRAINT approval_status_check CHECK (status IN (
  'pending', 'denied', 'executed', 'failed', 'expired'
));
