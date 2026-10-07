-- Migration 054: Add opt-in account-wide dashboard preference synchronization.

ALTER TABLE users ADD COLUMN dashboard_preferences_sync_enabled INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS dashboard_preferences (
    user_id INTEGER NOT NULL,
    workspace_id INTEGER NOT NULL,
    preferences_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, workspace_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dashboard_preferences_user ON dashboard_preferences(user_id);
