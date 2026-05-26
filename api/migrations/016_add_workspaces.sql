-- Migration 016: Add user workspaces as a display/organization layer.
-- Notifications, reminders and sync remain global; projects are assigned to workspaces.
-- Each workspace owns its own Inbox project.

CREATE TABLE IF NOT EXISTS workspaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#6366f1',
    sort_order INTEGER DEFAULT 0,
    user_id INTEGER NOT NULL,
    is_default INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_user_name_unique ON workspaces(user_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_user_default_unique ON workspaces(user_id) WHERE is_default = 1;
CREATE INDEX IF NOT EXISTS idx_workspaces_user ON workspaces(user_id);

INSERT OR IGNORE INTO workspaces (name, color, sort_order, user_id, is_default, updated_at)
SELECT 'Personal', '#10b981', 0, u.id, 1, datetime('now')
FROM users u
WHERE NOT EXISTS (
    SELECT 1 FROM workspaces w WHERE w.user_id = u.id
);

ALTER TABLE projects ADD COLUMN workspace_id INTEGER;

UPDATE projects
SET workspace_id = (
    SELECT w.id FROM workspaces w
    WHERE w.user_id = projects.user_id AND w.is_default = 1
    ORDER BY w.id LIMIT 1
)
WHERE workspace_id IS NULL AND user_id IS NOT NULL;

DROP INDEX IF EXISTS idx_projects_user_name_unique;
DROP INDEX IF EXISTS idx_projects_user_inbox_unique;

DROP INDEX IF EXISTS idx_projects_user_workspace_name_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_user_workspace_inbox_unique
ON projects(user_id, workspace_id)
WHERE is_inbox = 1;

CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id);

INSERT INTO projects (name, color, sort_order, user_id, workspace_id, is_inbox, updated_at)
SELECT 'Inbox', '#64748b', 0, w.user_id, w.id, 1, datetime('now')
FROM workspaces w
WHERE NOT EXISTS (
    SELECT 1 FROM projects p
    WHERE p.user_id = w.user_id
      AND p.workspace_id = w.id
      AND COALESCE(p.is_inbox, 0) = 1
);
