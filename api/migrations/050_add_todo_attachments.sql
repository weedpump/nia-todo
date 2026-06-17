-- Add file attachments for todos.

CREATE TABLE IF NOT EXISTS todo_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    todo_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    original_filename TEXT NOT NULL,
    stored_filename TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_todo_attachments_todo ON todo_attachments(todo_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_todo_attachments_user ON todo_attachments(user_id);

ALTER TABLE users ADD COLUMN attachment_quota_bytes INTEGER;

INSERT INTO app_config (key, value, updated_at)
VALUES
  ('attachments_enabled', '1', datetime('now')),
  ('attachments_allowed_types', '[".png",".jpg",".jpeg",".gif",".webp",".pdf"]', datetime('now')),
  ('attachments_default_quota_bytes', '5368709120', datetime('now'))
ON CONFLICT(key) DO NOTHING;
