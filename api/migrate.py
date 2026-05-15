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
                if "duplicate column" in error_msg or "already exists" in error_msg:
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
