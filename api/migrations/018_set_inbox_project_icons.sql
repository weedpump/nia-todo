-- Migration 018: Set default Lucide inbox icon for Inbox projects.

UPDATE projects
SET icon = 'inbox'
WHERE COALESCE(is_inbox, 0) = 1
  AND (icon IS NULL OR TRIM(icon) = '');
