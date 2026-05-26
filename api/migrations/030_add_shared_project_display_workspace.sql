-- Migration 030: Per-member display workspace for shared projects.
-- Shared project ownership/workspace stays with the owner; this column only controls
-- where the accepted member sees the shared project in their own workspace tree.

ALTER TABLE project_members ADD COLUMN workspace_id INTEGER;

UPDATE project_members
SET workspace_id = (
    SELECT w.id
    FROM workspaces w
    WHERE w.user_id = project_members.user_id
      AND COALESCE(w.is_default, 0) = 1
    ORDER BY w.id
    LIMIT 1
)
WHERE workspace_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_project_members_workspace ON project_members(workspace_id);
