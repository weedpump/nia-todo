#!/usr/bin/env python3
"""Manuelle Migrationen fuer nia-todo (Live-DB Kopie)."""

import sqlite3
import os
import sys
from pathlib import Path

DB_PATH = Path(__file__).parent / 'data' / 'nia-todo-dev.db'
MIGRATIONS_DIR = Path(__file__).parent / 'migrations'

def run_migration_003():
    """Migration 003: Users + admin_config + user_id Spalten."""
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    
    print("Migration 003: Add user support...")
    
    # Users Tabelle
    c.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            display_name TEXT,
            password_hash TEXT,
            is_admin INTEGER DEFAULT 0,
            token_version INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now'))
        )
    ''')
    
    # Admin config
    c.execute('''
        CREATE TABLE IF NOT EXISTS admin_config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            setup_complete INTEGER DEFAULT 0,
            admin_token_hash TEXT,
            jwt_secret TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )
    ''')
    
    # user_id Spalten (ignoriere Fehler)
    try:
        c.execute('ALTER TABLE projects ADD COLUMN user_id INTEGER')
    except:
        pass
    try:
        c.execute('ALTER TABLE todos ADD COLUMN user_id INTEGER')
    except:
        pass
    try:
        c.execute('ALTER TABLE sections ADD COLUMN user_id INTEGER')
    except:
        pass
    
    # Indices
    c.execute('CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id)')
    c.execute('CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id)')
    c.execute('CREATE INDEX IF NOT EXISTS idx_sections_user ON sections(user_id)')
    
    conn.commit()
    conn.close()
    print("✅ Migration 003 done")

def run_migration_004():
    """Migration 004: JWT support (idempotent, meiste Spalten schon in 003)."""
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    
    print("Migration 004: JWT support...")
    
    # jwt_secret ist schon in admin_config (003)
    # token_version ist schon in users (003)
    # Diese Migration ist ein No-Op, da alles in 003 erledigt wurde
    
    conn.commit()
    conn.close()
    print("✅ Migration 004 done (idempotent)")

def check_db():
    """Pruefe ob Migrationen noetig sind."""
    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()
    
    c.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = [t[0] for t in c.fetchall()]
    
    has_users = 'users' in tables
    has_admin = 'admin_config' in tables
    
    conn.close()
    
    return has_users and has_admin

if __name__ == '__main__':
    if not DB_PATH.exists():
        print(f"❌ DB not found: {DB_PATH}")
        sys.exit(1)
    
    if check_db():
        print("✅ Migrations already present")
        sys.exit(0)
    
    print("🚀 Starting migrations...")
    run_migration_003()
    run_migration_004()
    
    if check_db():
        print("✅ All migrations completed successfully!")
    else:
        print("❌ Migrations incomplete")
        sys.exit(1)
