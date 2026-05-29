-- Add lightweight favorites/pins for important todos.

ALTER TABLE todos ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_todos_pinned ON todos(is_pinned);
