-- Migration 017: Optional Lucide icon names for projects and workspaces.

ALTER TABLE projects ADD COLUMN icon TEXT;
ALTER TABLE workspaces ADD COLUMN icon TEXT;

UPDATE workspaces
SET icon = 'home'
WHERE COALESCE(is_default, 0) = 1
  AND name = 'Personal'
  AND (icon IS NULL OR TRIM(icon) = '');
