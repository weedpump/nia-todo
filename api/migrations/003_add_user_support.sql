-- Migration 003: Add user support + admin setup
-- Created: 2026-05-15
-- Purpose: Multi-user support with admin setup interface
-- NOTE: The migration system handles duplicate column errors gracefully.

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT,
    password_hash TEXT,
    is_admin INTEGER DEFAULT 0,
    token_version INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Admin config (single row for setup state)
CREATE TABLE IF NOT EXISTS admin_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    setup_complete INTEGER DEFAULT 0,
    admin_token_hash TEXT,
    jwt_secret TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Add user_id to existing tables
-- If these fail with "duplicate column", the migration system marks this as done
ALTER TABLE projects ADD COLUMN user_id INTEGER;
ALTER TABLE todos ADD COLUMN user_id INTEGER;
ALTER TABLE sections ADD COLUMN user_id INTEGER;

-- Add indices for performance
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id);
CREATE INDEX IF NOT EXISTS idx_sections_user ON sections(user_id);
