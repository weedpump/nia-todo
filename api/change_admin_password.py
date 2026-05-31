#!/usr/bin/env python3
"""
nia-todo: emergency admin password reset tool.

Default database resolution matches the application runtime:
- NIA_TODO_DATA_DIR controls the data directory
- NIA_TODO_DB controls the database filename/path
- --database can override both for recovery/testing

Interactive use:
    python3 api/change_admin_password.py

Non-interactive use:
    printf '%s\n' 'NewStrongPassword123!' | python3 api/change_admin_password.py --password-stdin
"""

from __future__ import annotations

import argparse
import getpass
import re
import sqlite3
import sys
from pathlib import Path

import bcrypt

try:
    from paths import DB_PATH
except Exception as exc:  # pragma: no cover - startup failure path
    print(f"❌ Could not resolve nia-todo runtime paths: {exc}", file=sys.stderr)
    sys.exit(1)


def validate_admin_password(password: str) -> str:
    """Admin passwords require at least 12 characters and mixed character classes."""
    if len(password) < 12:
        return "Password must be at least 12 characters long"
    if not re.search(r"[A-Z]", password):
        return "Password must contain at least one uppercase letter"
    if not re.search(r"[a-z]", password):
        return "Password must contain at least one lowercase letter"
    if not re.search(r"\d", password):
        return "Password must contain at least one digit"
    special_chars = r"!@#$%^&*()_+-=[]{};'\\|,.\/<>?"
    if not any(char in special_chars for char in password):
        return "Password must contain at least one special character"
    return ""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Reset the nia-todo admin password in the configured SQLite database."
    )
    parser.add_argument(
        "--database",
        type=Path,
        default=DB_PATH,
        help=f"SQLite database path (default: {DB_PATH})",
    )
    parser.add_argument(
        "--password-stdin",
        action="store_true",
        help="Read the new password from stdin instead of prompting interactively.",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Skip the interactive confirmation prompt when using --password-stdin.",
    )
    return parser.parse_args()


def read_password(password_stdin: bool, skip_confirm: bool) -> str:
    if password_stdin:
        new_password = sys.stdin.readline().rstrip("\r\n")
        if not new_password:
            print("❌ No password read from stdin.", file=sys.stderr)
            sys.exit(1)
        if not skip_confirm and sys.stdin.isatty():
            answer = input("Reset admin password with stdin value? Type YES to continue: ")
            if answer != "YES":
                print("❌ Aborted.", file=sys.stderr)
                sys.exit(1)
        return new_password

    new_password = getpass.getpass("Enter new admin password: ")
    if not new_password:
        print("❌ No password entered. Aborting.", file=sys.stderr)
        sys.exit(1)

    confirm_password = getpass.getpass("Confirm new admin password: ")
    if new_password != confirm_password:
        print("❌ Passwords do not match. Aborting.", file=sys.stderr)
        sys.exit(1)
    return new_password


def require_admin_config_table(conn: sqlite3.Connection) -> None:
    table = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'admin_config'"
    ).fetchone()
    if not table:
        raise RuntimeError(
            "admin_config table does not exist. Start nia-todo once so migrations can run, then retry."
        )


def ensure_admin_token_version_column(conn: sqlite3.Connection) -> None:
    columns = {row[1] for row in conn.execute("PRAGMA table_info(admin_config)").fetchall()}
    if "admin_token_version" not in columns:
        conn.execute("ALTER TABLE admin_config ADD COLUMN admin_token_version INTEGER DEFAULT 1")
        conn.execute("UPDATE admin_config SET admin_token_version = 1 WHERE admin_token_version IS NULL")


def reset_admin_password(database: Path, new_password: str) -> None:
    database = database.expanduser().resolve()
    if not database.exists():
        raise FileNotFoundError(f"Database not found: {database}")

    password_hash = bcrypt.hashpw(new_password.encode(), bcrypt.gensalt()).decode()

    conn = sqlite3.connect(str(database))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")

    try:
        require_admin_config_table(conn)
        ensure_admin_token_version_column(conn)

        row = conn.execute("SELECT id FROM admin_config WHERE id = 1").fetchone()
        if row:
            conn.execute(
                """
                UPDATE admin_config
                   SET admin_token_hash = ?,
                       setup_complete = 1,
                       admin_token_version = COALESCE(admin_token_version, 1) + 1
                 WHERE id = 1
                """,
                (password_hash,),
            )
        else:
            conn.execute(
                """
                INSERT INTO admin_config
                    (id, setup_complete, admin_token_hash, admin_token_version, created_at)
                VALUES
                    (1, 1, ?, 1, datetime('now'))
                """,
                (password_hash,),
            )

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def main() -> int:
    args = parse_args()
    database = args.database.expanduser()

    print("=" * 50)
    print("  nia-todo: Reset admin password")
    print("=" * 50)
    print(f"Database: {database}")
    print()

    new_password = read_password(args.password_stdin, args.yes)
    error = validate_admin_password(new_password)
    if error:
        print(f"❌ {error}", file=sys.stderr)
        return 1

    try:
        reset_admin_password(database, new_password)
    except Exception as exc:
        print(f"❌ Admin password reset failed: {exc}", file=sys.stderr)
        return 1

    print("✅ Admin password updated.")
    print("ℹ️  Existing admin sessions were invalidated via admin_token_version.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
