-- Migration: Add updated_at to sections table for offline sync
-- Created: 2026-05-16

ALTER TABLE sections ADD COLUMN updated_at TEXT;

-- Update existing sections with current timestamp
UPDATE sections SET updated_at = datetime('now') WHERE updated_at IS NULL;
