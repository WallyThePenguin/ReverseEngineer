-- Passkeys for Hearth's window on this PC (D69). A passkey works only at the address it was made
-- at. Hearth's own address (HEARTH_ORIGIN) is the https one; the desktop app's window opens Hearth
-- at http://localhost:<port>, where those can't work, so the window gets its own, made and used
-- only there. rp_id is null for Hearth's own address, as every passkey before this one was, and
-- 'localhost' for the window's.
ALTER TABLE credential ADD COLUMN rp_id text CHECK (rp_id = 'localhost');

-- A sign-in is checked at the address its challenge was made for, never the other.
ALTER TABLE auth_challenge ADD COLUMN rp_id text CHECK (rp_id = 'localhost');
