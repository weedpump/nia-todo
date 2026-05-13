"""Migration: Add sections support to existing database"""
import sqlite3
import sys
from pathlib import Path

DB_PATH = Path(__file__).parent / "nia-todo.db"
BACKUP_PATH = Path(__file__).parent / "nia-todo-pre-sections.db"

def migrate():
    if not DB_PATH.exists():
        print("Database not found, nothing to migrate.")
        return

    # Create backup if it doesn't exist
    if not BACKUP_PATH.exists():
        import shutil
        shutil.copy2(DB_PATH, BACKUP_PATH)
        print(f"Backup created at {BACKUP_PATH}")
    else:
        print(f"Backup already exists at {BACKUP_PATH}")

    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA foreign_keys = ON")

    # Check if sections table already exists
    tables = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sections'"
    ).fetchall()
    if tables:
        print("Sections table already exists. Migration already applied.")
        conn.close()
        return

    print("Applying migration...")

    # 1. Add section_id column to todos
    conn.execute("ALTER TABLE todos ADD COLUMN section_id INTEGER")
    print("Added section_id column to todos")

    # 2. Create sections table
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            sort_order INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
    """)
    print("Created sections table")

    # 3. Create indices
    conn.execute("CREATE INDEX IF NOT EXISTS idx_todos_section ON todos(section_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sections_project ON sections(project_id)")
    print("Created indices")

    conn.commit()
    conn.close()
    print("Migration complete!")

if __name__ == "__main__":
    migrate()
