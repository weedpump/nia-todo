-- BrainDump local user-specific route learning

ALTER TABLE users ADD COLUMN braindump_learning_enabled INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS braindump_route_learning (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    workspace_id INTEGER,
    token TEXT NOT NULL,
    project_id INTEGER NOT NULL,
    section_id INTEGER,
    hits INTEGER NOT NULL DEFAULT 1,
    last_used_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_braindump_route_learning_unique_route
    ON braindump_route_learning(user_id, COALESCE(workspace_id, -1), token, project_id, COALESCE(section_id, -1));

CREATE INDEX IF NOT EXISTS idx_braindump_route_learning_user_token
    ON braindump_route_learning(user_id, workspace_id, token);

CREATE INDEX IF NOT EXISTS idx_braindump_route_learning_user_updated
    ON braindump_route_learning(user_id, workspace_id, last_used_at);
