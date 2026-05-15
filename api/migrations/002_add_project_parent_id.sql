-- Migration 002: Add parent_id to projects for subproject support

ALTER TABLE projects ADD COLUMN parent_id INTEGER REFERENCES projects(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_projects_parent ON projects(parent_id);
