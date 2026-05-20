-- Migration 013: Repair inbox flags from early dev 012 candidate
-- Created: 2026-05-20
-- Purpose: Ensure each user has exactly one stable Inbox marker and never
--          promote regular default projects (Arbeit/Privat/Einkauf) to Inbox.

-- Undo accidental promotion of regular default project names to Inbox when a
-- user had deleted their Inbox before the stable flag existed.
UPDATE projects
SET is_inbox = 0
WHERE COALESCE(is_inbox, 0) = 1
  AND lower(name) IN ('arbeit', 'privat', 'einkauf');

-- Create a replacement Inbox for users that now have no Inbox marker.
INSERT INTO projects (name, color, sort_order, user_id, is_inbox, updated_at)
SELECT 'Inbox', '#64748b', 0, u.id, 1, datetime('now')
FROM users u
WHERE NOT EXISTS (
    SELECT 1 FROM projects p
    WHERE p.user_id = u.id AND COALESCE(p.is_inbox, 0) = 1
);

-- Move project-less todos to the repaired Inbox.
UPDATE todos
SET project_id = (
    SELECT p.id FROM projects p
    WHERE p.user_id = todos.user_id AND COALESCE(p.is_inbox, 0) = 1
    ORDER BY p.id
    LIMIT 1
)
WHERE project_id IS NULL
  AND user_id IS NOT NULL
  AND EXISTS (
      SELECT 1 FROM projects p
      WHERE p.user_id = todos.user_id AND COALESCE(p.is_inbox, 0) = 1
  );
