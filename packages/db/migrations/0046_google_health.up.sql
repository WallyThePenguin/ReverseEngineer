-- Google Calendar's sync judged the way Slack, GitHub and Notion are (D61), per Google account:
-- one notice when a run of failures starts (at once for one that won't pass by itself, else after
-- 3 failures and half an hour with nothing read), closed by the first good round. Before this,
-- any one failed round told you, once a day, and the notice never closed.
ALTER TABLE google_account
  ADD COLUMN calendar_state text NOT NULL DEFAULT 'ok'
    CHECK (calendar_state IN ('ok', 'failing', 'revoked')),
  ADD COLUMN calendar_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN calendar_failing_since timestamptz,
  ADD COLUMN calendar_synced_at timestamptz,
  ADD COLUMN calendar_error text;

-- Counted from when each account's calendars last synced, so an outage just after the upgrade
-- waits its half hour like any other.
UPDATE google_account g SET calendar_synced_at = c.at
FROM (
  SELECT account, max(last_synced_at) AS at FROM calendar WHERE selected GROUP BY account
) c
WHERE c.account = g.email;

-- What Google said when it last asked Hearth to slow down (its message, and the limit it hit),
-- so Settings and `hearth doctor` can say why mail or calendar is waiting.
ALTER TABLE google_quota ADD COLUMN reason text;

-- The old day-keyed calendar notices ("calendar.sync_failed:2026-10-05") never closed. A calendar
-- still failing raises a new one under the rules above.
UPDATE notification SET state = 'done', updated_at = now()
WHERE state <> 'done' AND dedupe_key ~ '^calendar\.sync_failed:[0-9]{4}-[0-9]{2}-[0-9]{2}$';
