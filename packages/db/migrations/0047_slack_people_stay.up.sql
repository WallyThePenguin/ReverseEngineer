-- What you decided for each person in your Slack (their tier, review, VIP) stays through
-- disconnecting Slack (D62): connecting again mustn't put someone you set to review back on
-- replies that go out on their own. slack.disconnect removes everyone else itself, so a person's
-- row no longer goes with the workspace's.
ALTER TABLE slack_user DROP CONSTRAINT slack_user_team_id_fkey;
