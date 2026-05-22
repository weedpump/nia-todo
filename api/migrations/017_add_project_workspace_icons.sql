-- Migration 017: Optional Lucide icon names for projects and workspaces.

ALTER TABLE projects ADD COLUMN icon TEXT;
ALTER TABLE workspaces ADD COLUMN icon TEXT;
