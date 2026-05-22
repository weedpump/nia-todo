"""nia-todo: SQLite Migrations-System

Migrationen werden als nummerierte .sql Dateien in migrations/ gespeichert.
Beim Server-Start wird automatisch geprüft welche fehlen und ausgeführt.
"""

import os
import sqlite3
import re
from pathlib import Path

# DB-Pfad: Env-Variable oder Default
DB_NAME = os.getenv('NIA_TODO_DB', 'nia-todo.db')
DB_PATH = Path(__file__).parent / "data" / DB_NAME

MIGRATIONS_DIR = Path(__file__).parent / "migrations"

def get_db_version(conn):
    """Holt aktuelle Schema-Version aus der DB."""
    cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    if not cursor.fetchone():
        return 0
    cursor = conn.execute("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
    row = cursor.fetchone()
    return row[0] if row else 0

def set_db_version(conn, version):
    """Setzt Schema-Version in der DB."""
    # SQLite kann nicht OR REPLACE mit PRIMARY KEY ohne ID
    # Lösche alte Versionen und füge neue ein
    conn.execute("DELETE FROM schema_version")
    conn.execute("INSERT INTO schema_version (version, applied_at) VALUES (?, datetime('now'))", (version,))
    conn.commit()

def column_exists(conn, table: str, column: str) -> bool:
    return any(row[1] == column for row in conn.execute(f"PRAGMA table_info({table})").fetchall())


def add_column_if_missing(conn, table: str, column: str, definition: str):
    if not column_exists(conn, table, column):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def repair_workspace_migration(conn):
    """Make migration 016 idempotent for DBs that already have workspace_id.

    SQLite cannot reliably ADD COLUMN IF NOT EXISTS across all supported
    versions. If a previous interrupted run added projects.workspace_id but did
    not finish indexes/default workspaces/inboxes, complete the remaining
    workspace schema here before marking migration 016 as applied.
    """
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS workspaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        color TEXT DEFAULT '#6366f1',
        sort_order INTEGER DEFAULT 0,
        user_id INTEGER NOT NULL,
        is_default INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_user_name_unique ON workspaces(user_id, name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_user_default_unique ON workspaces(user_id) WHERE is_default = 1;
    CREATE INDEX IF NOT EXISTS idx_workspaces_user ON workspaces(user_id);

    INSERT OR IGNORE INTO workspaces (name, color, sort_order, user_id, is_default, updated_at)
    SELECT 'Privat', '#10b981', 0, u.id, 1, datetime('now')
    FROM users u
    WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.user_id = u.id);

    UPDATE projects
    SET workspace_id = (
        SELECT w.id FROM workspaces w
        WHERE w.user_id = projects.user_id AND w.is_default = 1
        ORDER BY w.id LIMIT 1
    )
    WHERE workspace_id IS NULL AND user_id IS NOT NULL;

    DROP INDEX IF EXISTS idx_projects_user_name_unique;
    DROP INDEX IF EXISTS idx_projects_user_workspace_name_unique;
    DROP INDEX IF EXISTS idx_projects_user_inbox_unique;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_user_workspace_inbox_unique
    ON projects(user_id, workspace_id)
    WHERE is_inbox = 1;

    CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id);

    INSERT INTO projects (name, color, sort_order, user_id, workspace_id, is_inbox, updated_at)
    SELECT 'Inbox', '#64748b', 0, w.user_id, w.id, 1, datetime('now')
    FROM workspaces w
    WHERE NOT EXISTS (
        SELECT 1 FROM projects p
        WHERE p.user_id = w.user_id
          AND p.workspace_id = w.id
          AND COALESCE(p.is_inbox, 0) = 1
    );
    """)


def repair_icon_migration(conn):
    """Make migration 017 idempotent if one icon column was already added."""
    add_column_if_missing(conn, "projects", "icon", "TEXT")
    add_column_if_missing(conn, "workspaces", "icon", "TEXT")
    conn.commit()


def get_migration_files():
    """Holt alle Migrations-Dateien sortiert nach Nummer."""
    if not MIGRATIONS_DIR.exists():
        return []
    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    migrations = []
    for f in files:
        match = re.match(r"^(\d+)_.*\.sql$", f.name)
        if match:
            migrations.append((int(match.group(1)), f))
    migrations.sort(key=lambda x: x[0])
    return migrations

def init_migrations_table(conn):
    """Erstellt schema_version Tabelle falls nicht existiert."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY,
            applied_at TEXT DEFAULT (datetime('now'))
        )
    """)
    conn.commit()

def run_migrations():
    """Führt alle ausstehenden Migrationen aus."""
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    
    init_migrations_table(conn)
    current_version = get_db_version(conn)
    migrations = get_migration_files()
    
    if not migrations:
        conn.close()
        return current_version
    
    applied = 0
    for version, filepath in migrations:
        if version > current_version:
            print(f"[MIGRATION] Applying {filepath.name} (version {version})...")
            sql = filepath.read_text()
            
            try:
                conn.executescript(sql)
                set_db_version(conn, version)
                applied += 1
                print(f"[MIGRATION] ✅ {filepath.name} applied successfully")
            except sqlite3.OperationalError as e:
                error_msg = str(e).lower()
                if version == 16 and "duplicate column" in error_msg and column_exists(conn, "projects", "workspace_id"):
                    print(f"[MIGRATION] ⚠️ {filepath.name} - workspace_id exists, repairing remaining workspace schema")
                    repair_workspace_migration(conn)
                    set_db_version(conn, version)
                    applied += 1
                elif version == 17 and "duplicate column" in error_msg:
                    print(f"[MIGRATION] ⚠️ {filepath.name} - icon column exists, repairing remaining icon schema")
                    repair_icon_migration(conn)
                    set_db_version(conn, version)
                    applied += 1
                elif "duplicate column" in error_msg or "already exists" in error_msg:
                    print(f"[MIGRATION] ⚠️ {filepath.name} - parts already applied, marking as done")
                    set_db_version(conn, version)
                    applied += 1
                else:
                    print(f"[MIGRATION] ❌ Failed: {e}")
                    conn.close()
                    raise
            except sqlite3.Error as e:
                print(f"[MIGRATION] ❌ Failed: {e}")
                conn.close()
                raise
    
    conn.close()
    
    if applied > 0:
        print(f"[MIGRATION] {applied} migration(s) applied. DB now at version {version}")
    else:
        print(f"[MIGRATION] DB up to date (version {current_version})")
    
    return version if migrations else current_version

if __name__ == "__main__":
    run_migrations()
