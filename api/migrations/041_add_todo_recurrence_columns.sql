-- Migration 041: Add recurring todo columns for upgraded databases.
-- Purpose: Recurring todos shipped in 2.10 with recurring_rule/parent_id
-- present in the initial schema, but upgraded live databases can already have
-- schema_version > 1 while missing these columns. Without them, regular todo
-- updates that include recurring_rule fail with SQLite "no such column".

ALTER TABLE todos ADD COLUMN recurring_rule TEXT;
ALTER TABLE todos ADD COLUMN parent_id INTEGER;
