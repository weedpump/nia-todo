-- Migration 001: Initial schema for nia-todo
-- Created: 2026-05-15
-- Purpose: Create all base tables with subproject support

-- Projects/Kategorien
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#6366f1',
    sort_order INTEGER DEFAULT 0,
    parent_id INTEGER DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (parent_id) REFERENCES projects(id) ON DELETE CASCADE,
    UNIQUE(name, parent_id)
);

-- Todos
CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    priority INTEGER DEFAULT 3,
    status TEXT DEFAULT 'pending',
    due_date TEXT,
    completed_at TEXT,
    project_id INTEGER,
    section_id INTEGER,
    sort_order REAL DEFAULT 0,
    recurring_rule TEXT,
    parent_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
    FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE SET NULL,
    FOREIGN KEY (parent_id) REFERENCES todos(id) ON DELETE SET NULL
);

-- Sections
CREATE TABLE IF NOT EXISTS sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Reminders
CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    todo_id INTEGER NOT NULL,
    remind_at TEXT NOT NULL,
    sent_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE
);

-- Indices
CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
CREATE INDEX IF NOT EXISTS idx_todos_due ON todos(due_date);
CREATE INDEX IF NOT EXISTS idx_todos_project ON todos(project_id);
CREATE INDEX IF NOT EXISTS idx_todos_section ON todos(section_id);
CREATE INDEX IF NOT EXISTS idx_sections_project ON sections(project_id);
CREATE INDEX IF NOT EXISTS idx_reminders_at ON reminders(remind_at);
CREATE INDEX IF NOT EXISTS idx_projects_parent ON projects(parent_id);

-- Default projects
INSERT OR IGNORE INTO projects (id, name, color, sort_order) VALUES (1, 'Inbox', '#64748b', 0);
INSERT OR IGNORE INTO projects (id, name, color, sort_order) VALUES (2, 'Privat', '#10b981', 1);
INSERT OR IGNORE INTO projects (id, name, color, sort_order) VALUES (3, 'Arbeit', '#3b82f6', 2);
INSERT OR IGNORE INTO projects (id, name, color, sort_order) VALUES (4, 'Einkauf', '#f59e0b', 3);
