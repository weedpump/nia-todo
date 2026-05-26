-- Migration 011: Add project sharing support
-- Created: 2026-05-20
-- Purpose: Allow projects to be shared between users

-- Project members table (invitations + memberships)
CREATE TABLE IF NOT EXISTS project_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    invited_by INTEGER NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'declined', 'left', 'removed')),
    user_color TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(project_id, user_id)
);

-- Indices for performance
CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);
CREATE INDEX IF NOT EXISTS idx_project_members_status ON project_members(status);

-- Scope project name uniqueness to each user.
-- Migration 001 created projects.name as globally UNIQUE, which breaks multi-user
-- default projects because every user needs their own Inbox/Privat/Arbeit/Einkauf.
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS projects_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#6366f1',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    parent_id INTEGER,
    user_id INTEGER,
    is_inbox INTEGER DEFAULT 0
);

INSERT INTO projects_new (id, name, color, sort_order, created_at, updated_at, parent_id, user_id, is_inbox)
SELECT id, name, color, sort_order, created_at, updated_at, parent_id, user_id,
       CASE WHEN id = 1 OR lower(name) = 'inbox' THEN 1 ELSE 0 END
FROM projects;

DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_user_name_unique ON projects(user_id, name);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_parent ON projects(parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_user_inbox_unique ON projects(user_id) WHERE is_inbox = 1;

PRAGMA foreign_keys = ON;
