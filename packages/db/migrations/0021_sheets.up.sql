-- Spreadsheets (M7). The workbook is JSON: each sheet's cells as typed (values and =formulas).
-- Results are worked out by IronCalc when read; the entity's body is the results as markdown
-- tables, so search, backlinks and Jarvis read it. Last write wins (D20); version counts saves.
CREATE TABLE sheet_book (
  entity_id uuid PRIMARY KEY REFERENCES entity(id) ON DELETE CASCADE,
  data jsonb NOT NULL,
  version integer NOT NULL DEFAULT 0
);
