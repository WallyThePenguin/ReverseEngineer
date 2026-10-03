DROP TABLE IF EXISTS meeting_segment;
DROP TABLE IF EXISTS meeting;
UPDATE entity SET created_by = 'jarvis', updated_by = 'jarvis' WHERE created_by = 'integration:meetings';
DELETE FROM principal WHERE id = 'integration:meetings';
