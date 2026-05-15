"""nia-todo: SQLite Migrations-System

Migrationen werden als nummerierte .sql Dateien in migrations/ gespeichert.
Beim Server-Start wird automatisch geprüft welche fehlen und ausgeführt.
"""

import os
import sqlite3
import re
import bcrypt
from pathlib import Path
from db import DB_PATH, get_db

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
    conn.execute("INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, datetime('now'))", (version,))
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

def hash_passwords_in_sql(sql):
    """Ersetzt Passwort-Platzhalter in Migration 003 durch bcrypt-Hashes."""
    if 'PLACEHOLDER_TOBI' in sql:
        pw_tobi = os.getenv('NIA_TODO_PASSWORD_TOBI', '0HN2QIlB8ZHq')
        pw_moni = os.getenv('NIA_TODO_PASSWORD_MONI', 'Sfg3Tvw6uP0Q')
        hash_tobi = bcrypt.hashpw(pw_tobi.encode(), bcrypt.gensalt()).decode()
        hash_moni = bcrypt.hashpw(pw_moni.encode(), bcrypt.gensalt()).decode()
        sql = sql.replace('PLACEHOLDER_TOBI', hash_tobi)
        sql = sql.replace('PLACEHOLDER_MONI', hash_moni)
    return sql

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
            
            # Special handling: hash passwords for migration 003
            sql = hash_passwords_in_sql(sql)
            
            try:
                conn.executescript(sql)
                set_db_version(conn, version)
                applied += 1
                print(f"[MIGRATION] ✅ {filepath.name} applied successfully")
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
