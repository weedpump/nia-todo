#!/usr/bin/env python3
"""Setup default users for nia-todo.

Run this manually after deployment to create the initial users.
Users and passwords are defined here (not in migrations) for security.

Usage:
    cd ~/projects/nia-todo/api && python3 setup_users.py
"""

import sqlite3
import bcrypt
import sys
from pathlib import Path

# ─── CONFIG: Define users here ──────────────────────────────────────────────
# Format: (username, display_name, password)
DEFAULT_USERS = [
    ('tobi', 'Tobi', 'CHANGEME_TOBI'),
    ('moni', 'Moni', 'CHANGEME_MONI'),
]

DB_PATH = Path(__file__).parent / 'data' / 'nia-todo.db'
# Use dev DB if running from dev environment
if 'nia-todo-dev' in str(Path(__file__)):
    DB_PATH = Path(__file__).parent / 'data' / 'nia-todo-dev.db'

# ─── Helper ──────────────────────────────────────────────────────────────────

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()

def create_user(db_path: Path, username: str, display_name: str, password: str):
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    c = conn.cursor()

    # Check if user exists
    existing = c.execute(
        "SELECT id FROM users WHERE username = ?", (username,)
    ).fetchone()

    if existing:
        print(f"⚠️  User '{username}' already exists (id={existing['id']})")
        conn.close()
        return

    # Create user
    password_hash = hash_password(password)
    c.execute(
        "INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, ?)",
        (username, display_name, password_hash)
    )
    user_id = c.lastrowid
    conn.commit()
    conn.close()

    print(f"✅ Created user '{username}' (id={user_id})")

# ─── Main ────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    print(f"Setting up users in: {DB_PATH}")

    if not DB_PATH.exists():
        print(f"❌ Database not found: {DB_PATH}")
        print("   Start the server first to create the DB.")
        sys.exit(1)

    for username, display_name, password in DEFAULT_USERS:
        create_user(DB_PATH, username, display_name, password)

    print("\n🎉 Done! Users created successfully.")
    print("⚠️  IMPORTANT: Change the default passwords in this file before deploying!")
