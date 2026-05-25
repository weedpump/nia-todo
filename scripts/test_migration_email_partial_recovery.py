#!/usr/bin/env python3
"""Regression test for recovering partially applied email migrations 021/023."""

import sqlite3
import sys
import tempfile
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE / "api"))

import migrate  # noqa: E402


def table_columns(conn, table):
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def main():
    original_db_path = migrate.DB_PATH
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "partial-email-migration.db"
        conn = sqlite3.connect(db_path)
        conn.executescript("""
            CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')));
            INSERT INTO schema_version (version) VALUES (20);

            CREATE TABLE app_config (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                email TEXT,
                password_hash TEXT,
                email_verified_at TEXT
            );

            CREATE TABLE password_setup_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token_hash TEXT NOT NULL,
                token_prefix TEXT NOT NULL,
                purpose TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                used_at TEXT,
                created_by_admin INTEGER DEFAULT 1
            );

            CREATE TABLE workspaces (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                color TEXT DEFAULT '#6366f1',
                sort_order INTEGER DEFAULT 0,
                user_id INTEGER NOT NULL,
                is_default INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                color TEXT DEFAULT '#6366f1',
                sort_order INTEGER DEFAULT 0,
                user_id INTEGER,
                workspace_id INTEGER,
                is_inbox INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE project_members (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                role TEXT DEFAULT 'member',
                status TEXT DEFAULT 'pending',
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );

            INSERT INTO users (username, email, password_hash, email_verified_at)
            VALUES ('legacy', 'Legacy@Example.Invalid', 'hash', NULL);

            INSERT INTO password_setup_tokens (user_id, token_hash, token_prefix, purpose, expires_at, used_at)
            VALUES (1, 'hash', 'prefix', 'reset', datetime('now', '+1 hour'), datetime('now'));
        """)
        conn.close()

        migrate.DB_PATH = db_path
        try:
            version = migrate.run_migrations()
        finally:
            migrate.DB_PATH = original_db_path

        conn = sqlite3.connect(db_path)
        latest_version = max(v for v, _ in migrate.get_migration_files())
        assert version == latest_version, version
        assert conn.execute("SELECT version FROM schema_version").fetchone()[0] == latest_version
        user_cols = table_columns(conn, "users")
        for column in (
            "email_verified_at",
            "pending_email",
            "pending_email_token_hash",
            "pending_email_token_prefix",
            "pending_email_token_expires_at",
            "email_changed_at",
            "email_trust_source",
            "two_factor_enabled",
            "two_factor_totp_secret",
            "two_factor_recovery_hashes",
        ):
            assert column in user_cols, column
        challenge_cols = table_columns(conn, "two_factor_challenges")
        for column in ("attempts", "locked_until"):
            assert column in challenge_cols, column
        passkey_challenge_cols = table_columns(conn, "passkey_challenges")
        for column in ("attempts", "locked_until"):
            assert column in passkey_challenge_cols, column
        token_cols = table_columns(conn, "password_setup_tokens")
        for column in ("status", "replaced_at", "requested_by"):
            assert column in token_cols, column
        user = conn.execute("SELECT email, email_verified_at, email_trust_source FROM users WHERE username = 'legacy'").fetchone()
        assert user[0] == "legacy@example.invalid", user
        assert user[1] is not None, user
        assert user[2] == "legacy_verified", user
        token = conn.execute("SELECT status, requested_by FROM password_setup_tokens WHERE id = 1").fetchone()
        assert token == ("used", "admin"), token
        indexes = {row[1] for row in conn.execute("PRAGMA index_list(users)").fetchall()}
        assert "idx_users_email_unique_ci" in indexes, indexes
        assert "idx_users_pending_email_unique_ci" in indexes, indexes
        assert "idx_users_email_trust_source" in indexes, indexes
        conn.close()
    print("✅ Email partial-migration recovery test passed")


if __name__ == "__main__":
    main()
