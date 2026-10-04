-- Notion import (M7): pages imported from a Notion export are written by this integration, so
-- Jarvis reads them as outside content.
INSERT INTO principal (id, kind, display_name) VALUES ('integration:notion', 'integration', 'Notion import');
