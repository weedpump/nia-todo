-- Migration 012: Add stable per-user Inbox marker
-- Created: 2026-05-20
-- Purpose: Inbox must be identified independently from its editable display name.

ALTER TABLE projects ADD COLUMN is_inbox INTEGER DEFAULT 0;

-- Existing installs: mark the original global Inbox and per-user default Inbox projects.
UPDATE projects SET is_inbox = 1 WHERE id = 1 OR lower(name) = 'inbox';

-- Safety net: if a user somehow has no Inbox project, create one instead of
-- guessing by name/order. Users may rename their Inbox later; from this point
-- on is_inbox is the stable identity.
INSERT INTO projects (name, color, sort_order, user_id, is_inbox, updated_at)
SELECT 'Inbox', '#64748b', 0, u.id, 1, datetime('now')
FROM users u
WHERE NOT EXISTS (
    SELECT 1 FROM projects p
    WHERE p.user_id = u.id AND p.is_inbox = 1
);

-- Restore project-less user todos to their user's Inbox.
UPDATE todos
SET project_id = (
    SELECT p.id FROM projects p
    WHERE p.user_id = todos.user_id AND p.is_inbox = 1
    ORDER BY p.id
    LIMIT 1
)
WHERE project_id IS NULL
  AND user_id IS NOT NULL
  AND EXISTS (
      SELECT 1 FROM projects p
      WHERE p.user_id = todos.user_id AND p.is_inbox = 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_user_inbox_unique
ON projects(user_id)
WHERE is_inbox = 1;
