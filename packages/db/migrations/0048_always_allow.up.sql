-- "Always allow" on an approval card (D70). A rule can be as narrow as the card: the action, and
-- the one place or person it reaches (target: a channel, a person). '' is the whole action, as
-- every rule written before.
ALTER TABLE standing_rule ADD COLUMN target text NOT NULL DEFAULT '';
ALTER TABLE standing_rule DROP CONSTRAINT standing_rule_action_principal_key;
ALTER TABLE standing_rule ADD CONSTRAINT standing_rule_scope UNIQUE (action, principal, target);

-- What Always allow would cover for a request, set when it's asked: the rule's target and the
-- button's words ({"target": "C123", "says": "posting in #eng"}). Null when it can't offer one.
ALTER TABLE approval ADD COLUMN always_allow jsonb;
