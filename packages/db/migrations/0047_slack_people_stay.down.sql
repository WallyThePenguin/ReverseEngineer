DELETE FROM slack_user WHERE team_id NOT IN (SELECT team_id FROM slack_workspace);
ALTER TABLE slack_user
  ADD CONSTRAINT slack_user_team_id_fkey
  FOREIGN KEY (team_id) REFERENCES slack_workspace (team_id) ON DELETE CASCADE;
