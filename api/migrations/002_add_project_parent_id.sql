-- Migration 002: Add parent_id column to projects for subproject support
-- Safe for existing databases with data

ALTER TABLE projects ADD COLUMN parent_id INTEGER DEFAULT NULL REFERENCES projects(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_projects_parent ON projects(parent_id);
