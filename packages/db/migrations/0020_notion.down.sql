DELETE FROM link WHERE created_by = 'integration:notion';
DELETE FROM entity WHERE created_by = 'integration:notion';
DELETE FROM principal WHERE id = 'integration:notion';
