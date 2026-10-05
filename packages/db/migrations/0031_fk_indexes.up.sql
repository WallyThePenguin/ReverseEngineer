-- Indexes for the foreign keys that deletes follow. Deleting a record (disconnecting Google or
-- Slack removes thousands of mail, calendar and message records at once) makes Postgres look in
-- every table that points at it, and without an index each look read the whole table.
-- notification (approval_id) is also how an approval finds its inbox item.
CREATE INDEX notification_approval ON notification (approval_id);
CREATE INDEX notification_entity ON notification (entity_id);
CREATE INDEX task_project ON task (project_id);
CREATE INDEX jarvis_turn_conversation ON jarvis_turn (conversation_id);
CREATE INDEX jarvis_turn_subject ON jarvis_turn (subject_id);
CREATE INDEX observation_about ON observation (about_id);
CREATE INDEX observation_supersedes ON observation (supersedes);
CREATE INDEX heartbeat_item_about ON heartbeat_item (about_id);
CREATE INDEX watch_conversation ON watch (conversation_id);
CREATE INDEX watch_subject ON watch (subject_id);
CREATE INDEX calendar_account ON calendar (account);
CREATE INDEX mail_op_account ON mail_op (account_id);
CREATE INDEX mail_op_thread ON mail_op (thread_id);
CREATE INDEX mail_draft_account ON mail_draft (account_id);
CREATE INDEX slack_channel_team ON slack_channel (team_id);
CREATE INDEX slack_user_team ON slack_user (team_id);
CREATE INDEX slack_user_person ON slack_user (person_id);
