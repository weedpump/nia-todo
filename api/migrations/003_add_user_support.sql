-- Migration 003: Add user support
-- Created: 2026-05-15
-- Purpose: Add users table and user_id to all data tables

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Insert default users (passwords are handled separately via API tokens)
INSERT OR IGNORE INTO users (id, username, display_name) VALUES (1, 'tobi', 'Tobi');
INSERT OR IGNORE INTO users (id, username, display_name) VALUES (2, 'moni', 'Moni');

-- Add user_id to existing tables
ALTER TABLE projects ADD COLUMN user_id INTEGER DEFAULT 1;
ALTER TABLE todos ADD COLUMN user_id INTEGER DEFAULT 1;
ALTER TABLE sections ADD COLUMN user_id INTEGER DEFAULT 1;

-- Add foreign key constraints (SQLite doesn't enforce FK by default, but for documentation)
-- Note: SQLite only supports FK constraints defined at table creation time
-- We'll enforce these at the application level.

-- Update existing data to belong to user 1 (tobi)
UPDATE projects SET user_id = 1;
UPDATE todos SET user_id = 1;
UPDATE sections SET user_id = 1;

-- Add indices for performance
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id);
CREATE INDEX IF NOT EXISTS idx_sections_user ON sections(user_id);
