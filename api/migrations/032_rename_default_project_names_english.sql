-- Migration 032: Use language-neutral English names for built-in default workspaces/projects.
-- Only exact legacy default names with their original colors/sort orders are renamed.

UPDATE workspaces
SET name = 'Personal', updated_at = datetime('now')
WHERE name = 'Privat'
  AND color = '#10b981'
  AND sort_order = 0
  AND COALESCE(is_default, 0) = 1
  AND NOT EXISTS (
    SELECT 1 FROM workspaces w2
    WHERE w2.user_id = workspaces.user_id
      AND w2.name = 'Personal'
      AND w2.id != workspaces.id
  );

UPDATE projects
SET name = 'Personal', updated_at = datetime('now')
WHERE name = 'Privat'
  AND color = '#10b981'
  AND sort_order IN (0, 1)
  AND COALESCE(is_inbox, 0) = 0
  AND NOT EXISTS (
    SELECT 1 FROM projects p2
    WHERE p2.user_id = projects.user_id
      AND COALESCE(p2.workspace_id, -1) = COALESCE(projects.workspace_id, -1)
      AND p2.name = 'Personal'
      AND p2.id != projects.id
  );

UPDATE projects
SET name = 'Work', updated_at = datetime('now')
WHERE name = 'Arbeit'
  AND color = '#3b82f6'
  AND sort_order = 2
  AND COALESCE(is_inbox, 0) = 0
  AND NOT EXISTS (
    SELECT 1 FROM projects p2
    WHERE p2.user_id = projects.user_id
      AND COALESCE(p2.workspace_id, -1) = COALESCE(projects.workspace_id, -1)
      AND p2.name = 'Work'
      AND p2.id != projects.id
  );

UPDATE projects
SET name = 'Shopping', updated_at = datetime('now')
WHERE name = 'Einkauf'
  AND color = '#f59e0b'
  AND sort_order = 3
  AND COALESCE(is_inbox, 0) = 0
  AND NOT EXISTS (
    SELECT 1 FROM projects p2
    WHERE p2.user_id = projects.user_id
      AND COALESCE(p2.workspace_id, -1) = COALESCE(projects.workspace_id, -1)
      AND p2.name = 'Shopping'
      AND p2.id != projects.id
  );
