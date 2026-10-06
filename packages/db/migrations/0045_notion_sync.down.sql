DELETE FROM entity WHERE type = 'notion_task';
DROP TABLE notion_task;
DROP TABLE notion_account;
UPDATE principal SET display_name = 'Notion import' WHERE id = 'integration:notion';
