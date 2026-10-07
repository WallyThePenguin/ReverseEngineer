ALTER TABLE approval DROP COLUMN always_allow;

-- A rule narrowed to one place can't be kept without its place: it goes, and Jarvis asks again.
DELETE FROM standing_rule WHERE target IS NOT NULL;
ALTER TABLE standing_rule DROP CONSTRAINT standing_rule_scope;
ALTER TABLE standing_rule
  ADD CONSTRAINT standing_rule_action_principal_key UNIQUE (action, principal);
ALTER TABLE standing_rule DROP COLUMN target;
