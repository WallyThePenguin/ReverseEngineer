DELETE FROM schedule WHERE id LIKE 'routine-of:%';
DELETE FROM entity WHERE type = 'routine';
DROP TABLE IF EXISTS routine;
DROP TABLE IF EXISTS vault_login;
