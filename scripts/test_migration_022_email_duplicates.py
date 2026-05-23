#!/usr/bin/env python3
"""Regression test for migration 022 with pre-existing case-duplicate emails."""

import sqlite3
import tempfile
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
MIGRATION = BASE / "api" / "migrations" / "022_case_insensitive_email_uniqueness.sql"


def main():
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "migration-022-test.db"
        conn = sqlite3.connect(db_path)
        conn.execute("""
            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT,
                email_verified_at TEXT,
                pending_email TEXT,
                pending_email_token_hash TEXT,
                pending_email_token_prefix TEXT,
                pending_email_token_expires_at TEXT,
                email_changed_at TEXT
            )
        """)
        conn.execute("CREATE UNIQUE INDEX idx_users_email_unique ON users(email) WHERE email IS NOT NULL AND email != ''")
        conn.execute("CREATE UNIQUE INDEX idx_users_pending_email_unique ON users(pending_email) WHERE pending_email IS NOT NULL AND pending_email != ''")
        conn.executemany(
            """INSERT INTO users (email, email_verified_at, pending_email, pending_email_token_hash, pending_email_token_prefix, pending_email_token_expires_at)
               VALUES (?, datetime('now'), ?, 'hash', 'prefix', datetime('now', '+1 hour'))""",
            [
                ("Alice@Example.invalid", None),
                ("alice@example.invalid", None),
                ("bob@example.invalid", "Carol@Example.invalid"),
                ("dave@example.invalid", "carol@example.invalid"),
                ("eve@example.invalid", "BOB@example.invalid"),
            ],
        )
        conn.commit()
        conn.executescript(MIGRATION.read_text())

        rows = conn.execute("SELECT id, email, email_verified_at, pending_email FROM users ORDER BY id").fetchall()
        assert rows[0][1] == "alice@example.invalid", rows
        assert rows[1][1] is None and rows[1][2] is None, rows
        assert rows[2][3] == "carol@example.invalid", rows
        assert rows[3][3] is None, rows
        assert rows[4][3] is None, rows

        duplicate_email_count = conn.execute(
            "SELECT COUNT(*) FROM users WHERE lower(email) = 'alice@example.invalid'"
        ).fetchone()[0]
        assert duplicate_email_count == 1

        try:
            conn.execute("INSERT INTO users (email) VALUES ('ALICE@example.invalid')")
            raise AssertionError("case-insensitive email unique index did not reject duplicate")
        except sqlite3.IntegrityError:
            pass

        try:
            conn.execute("INSERT INTO users (pending_email) VALUES ('CAROL@example.invalid')")
            raise AssertionError("case-insensitive pending_email unique index did not reject duplicate")
        except sqlite3.IntegrityError:
            pass

        conn.close()
    print("✅ Migration 022 duplicate-email test passed")


if __name__ == "__main__":
    main()
