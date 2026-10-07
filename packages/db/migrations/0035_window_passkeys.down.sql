-- The window's passkeys go with the column: without it they'd be offered at Hearth's own address,
-- where they can't work.
DELETE FROM auth_challenge WHERE rp_id IS NOT NULL;
DELETE FROM credential WHERE rp_id IS NOT NULL;
ALTER TABLE auth_challenge DROP COLUMN rp_id;
ALTER TABLE credential DROP COLUMN rp_id;
