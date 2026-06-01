"""nia-todo: Selfhosted Todo-System mit SQLite + FastAPI + Web-UI"""

import sqlite3
import json
from datetime import datetime, timezone
from contextlib import contextmanager

from paths import DB_PATH

INIT_SQL = """
-- Projects/Kategorien
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#6366f1',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    is_inbox INTEGER DEFAULT 0
);

-- Todos
CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    priority INTEGER DEFAULT 3,
    is_pinned INTEGER DEFAULT 0,
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
    user_id INTEGER,
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

-- Default projects
INSERT OR IGNORE INTO projects (id, name, color, sort_order, is_inbox) VALUES (1, 'Inbox', '#64748b', 0, 1);
INSERT OR IGNORE INTO projects (id, name, color, sort_order, is_inbox) VALUES (2, 'Personal', '#10b981', 1, 0);
INSERT OR IGNORE INTO projects (id, name, color, sort_order, is_inbox) VALUES (3, 'Work', '#3b82f6', 2, 0);
INSERT OR IGNORE INTO projects (id, name, color, sort_order, is_inbox) VALUES (4, 'Shopping', '#f59e0b', 3, 0);
"""

@contextmanager
def get_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), detect_types=sqlite3.PARSE_DECLTYPES)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

def init_db():
    with get_db() as conn:
        conn.executescript(INIT_SQL)
        try:
            conn.execute("ALTER TABLE users ADD COLUMN language TEXT DEFAULT 'auto'")
        except Exception:
            pass
        try:
            conn.execute("ALTER TABLE todos ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0")
        except Exception:
            pass
        conn.execute("CREATE INDEX IF NOT EXISTS idx_todos_pinned ON todos(is_pinned)")
        conn.commit()

def row_to_dict(row):
    if row is None:
        return None
    d = dict(row)
    for k in ['reminders']:
        if k not in d:
            d[k] = []
    return d

def now_iso():
    return datetime.now(timezone.utc).isoformat()
