-- When mail and each account's calendars last tried to sync, worked or not. A long gap since then
-- means the PC slept or Hearth was off, so the first failures after it start a new run instead
-- of adding to one from before, and can't alert by themselves.
ALTER TABLE mail_account ADD COLUMN attempted_at timestamptz;
ALTER TABLE google_account ADD COLUMN calendar_attempted_at timestamptz;

-- Google's kind of event: "default", or an entry it adds itself ("workingLocation", "birthday",
-- "outOfOffice", "focusTime", "fromGmail"). The brief and journal leave out where you work and
-- birthdays. Rows from before say "default" until the next sync reads them again.
ALTER TABLE calendar_event ADD COLUMN kind text NOT NULL DEFAULT 'default';
