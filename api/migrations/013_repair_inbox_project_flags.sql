-- Migration 013: Repair project sharing/inbox schema drift
-- Created: 2026-05-20
-- Purpose: Heal databases that reached schema_version=12 from an unreleased
--          intermediate build but still have the old projects/project_members
--          layout. Migration 012 intentionally stays unchanged; 013 is the
--          forward repair migration.

PRAGMA foreign_keys = OFF;

-- Rebuild projects so the old global UNIQUE(name) constraint disappears and
-- the stable is_inbox marker exists even when 012 was previously marked applied
-- without adding the column.
DROP TABLE IF EXISTS projects_new;

CREATE TABLE projects_new (
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

-- Recreate project_members in the final sharing schema. Project sharing was not
-- released before 1.0.0; old pre-release table variants are discarded here to
-- guarantee the API has status/user_color/updated_at and correct constraints.
DROP TABLE IF EXISTS project_members;

CREATE TABLE project_members (
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

-- Existing installs: mark the original global Inbox and per-user Inbox projects.
UPDATE projects
SET is_inbox = 1
WHERE id = 1 OR lower(name) = 'inbox';

-- Never promote regular default projects to Inbox.
UPDATE projects
SET is_inbox = 0
WHERE COALESCE(is_inbox, 0) = 1
  AND lower(name) IN ('arbeit', 'privat', 'einkauf');

-- Create a replacement Inbox for users that have no Inbox marker.
INSERT INTO projects (name, color, sort_order, user_id, is_inbox, updated_at)
SELECT 'Inbox', '#64748b', 0, u.id, 1, datetime('now')
FROM users u
WHERE NOT EXISTS (
    SELECT 1 FROM projects p
    WHERE p.user_id = u.id AND COALESCE(p.is_inbox, 0) = 1
);

-- Move project-less todos to the user's repaired Inbox.
UPDATE todos
SET project_id = (
    SELECT p.id FROM projects p
    WHERE p.user_id = todos.user_id AND COALESCE(p.is_inbox, 0) = 1
    ORDER BY p.id
    LIMIT 1
)
WHERE project_id IS NULL
  AND user_id IS NOT NULL
  AND EXISTS (
      SELECT 1 FROM projects p
      WHERE p.user_id = todos.user_id AND COALESCE(p.is_inbox, 0) = 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_user_name_unique ON projects(user_id, name);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_parent ON projects(parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_user_inbox_unique ON projects(user_id) WHERE is_inbox = 1;

CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);
CREATE INDEX IF NOT EXISTS idx_project_members_status ON project_members(status);

PRAGMA foreign_keys = ON;
