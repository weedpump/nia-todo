"""nia-todo: Selfhosted Todo-System mit SQLite + FastAPI + Web-UI"""

import sqlite3
import json
from datetime import datetime, timezone
from pathlib import Path
from contextlib import contextmanager

DB_PATH = Path(__file__).parent / "data" / "nia-todo.db"
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

INIT_SQL = """
-- Projects/Kategorien
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    color TEXT DEFAULT '#6366f1',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Labels
CREATE TABLE IF NOT EXISTS labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    color TEXT DEFAULT '#8b5cf6',
    created_at TEXT DEFAULT (datetime('now'))
);

-- Todos
CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    priority INTEGER DEFAULT 3, -- 1=🔴 highest, 2=🟡 high, 3=🟢 medium, 4=⚪ low
    status TEXT DEFAULT 'pending', -- pending, in_progress, done, archived
    due_date TEXT, -- ISO 8601
    completed_at TEXT,
    project_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);

-- Todo-Labels n:m
CREATE TABLE IF NOT EXISTS todo_labels (
    todo_id INTEGER NOT NULL,
    label_id INTEGER NOT NULL,
    PRIMARY KEY (todo_id, label_id),
    FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE,
    FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE CASCADE
);

-- Reminders
CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    todo_id INTEGER NOT NULL,
    remind_at TEXT NOT NULL, -- ISO 8601
    sent_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE
);

-- Indices
CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
CREATE INDEX IF NOT EXISTS idx_todos_due ON todos(due_date);
CREATE INDEX IF NOT EXISTS idx_todos_project ON todos(project_id);
CREATE INDEX IF NOT EXISTS idx_reminders_at ON reminders(remind_at);

-- Default projects
INSERT OR IGNORE INTO projects (id, name, color, sort_order) VALUES (1, 'Inbox', '#64748b', 0);
INSERT OR IGNORE INTO projects (id, name, color, sort_order) VALUES (2, 'Privat', '#10b981', 1);
INSERT OR IGNORE INTO projects (id, name, color, sort_order) VALUES (3, 'Arbeit', '#3b82f6', 2);
INSERT OR IGNORE INTO projects (id, name, color, sort_order) VALUES (4, 'Einkauf', '#f59e0b', 3);
"""

@contextmanager
def get_db():
    conn = sqlite3.connect(str(DB_PATH), detect_types=sqlite3.PARSE_DECLTYPES)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
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
        conn.commit()

def row_to_dict(row):
    if row is None:
        return None
    d = dict(row)
    for k in ['labels', 'reminders']:
        if k not in d:
            d[k] = []
    return d

def now_iso():
    return datetime.now(timezone.utc).isoformat()
