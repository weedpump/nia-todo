-- Migration 003: Add user support
-- Created: 2026-05-15
-- Purpose: Add users table and user_id to all data tables
-- NOTE: Default users must be created manually after deployment.
--       See api/setup_users.py or run: python3 api/setup_users.py

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT,
    password_hash TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Add user_id to existing tables (defaults to 1 for first user)
ALTER TABLE projects ADD COLUMN user_id INTEGER DEFAULT 1;
ALTER TABLE todos ADD COLUMN user_id INTEGER DEFAULT 1;
ALTER TABLE sections ADD COLUMN user_id INTEGER DEFAULT 1;

-- Update existing data to belong to user 1 (first user to be created)
UPDATE projects SET user_id = 1;
UPDATE todos SET user_id = 1;
UPDATE sections SET user_id = 1;

-- Add indices for performance
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id);
CREATE INDEX IF NOT EXISTS idx_sections_user ON sections(user_id);
