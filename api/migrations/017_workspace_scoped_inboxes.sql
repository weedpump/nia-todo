-- Migration 017: Scope inbox projects per workspace instead of per user.
-- Each workspace gets its own Inbox project; deleting a workspace can then move
-- its inbox todos into the default workspace inbox.

DROP INDEX IF EXISTS idx_projects_user_inbox_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_user_workspace_inbox_unique
ON projects(user_id, workspace_id)
WHERE is_inbox = 1;

INSERT INTO projects (name, color, sort_order, user_id, workspace_id, is_inbox, updated_at)
SELECT 'Inbox', '#64748b', 0, w.user_id, w.id, 1, datetime('now')
FROM workspaces w
WHERE NOT EXISTS (
    SELECT 1 FROM projects p
    WHERE p.user_id = w.user_id
      AND p.workspace_id = w.id
      AND COALESCE(p.is_inbox, 0) = 1
);
