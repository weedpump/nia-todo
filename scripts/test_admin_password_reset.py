#!/usr/bin/env python3
"""Smoke-test the admin password reset recovery tool."""

import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

import bcrypt

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "api" / "change_admin_password.py"
PASSWORD = "RecoveredAdmin123!"


def fail(message: str) -> None:
    print(f"❌ {message}", file=sys.stderr)
    sys.exit(1)


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "nia-todo.db"
        conn = sqlite3.connect(db_path)
        conn.execute(
            """
            CREATE TABLE admin_config (
                id INTEGER PRIMARY KEY,
                setup_complete INTEGER DEFAULT 0,
                admin_token_hash TEXT,
                admin_token_version INTEGER DEFAULT 1,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        old_hash = bcrypt.hashpw(b"OldAdmin123!", bcrypt.gensalt()).decode()
        conn.execute(
            "INSERT INTO admin_config (id, setup_complete, admin_token_hash, admin_token_version) VALUES (1, 1, ?, 7)",
            (old_hash,),
        )
        conn.commit()
        conn.close()

        env = os.environ.copy()
        env["NIA_TODO_DATA_DIR"] = tmp
        env["NIA_TODO_DB"] = "nia-todo.db"
        proc = subprocess.run(
            [sys.executable, str(SCRIPT), "--password-stdin"],
            input=PASSWORD + "\n",
            text=True,
            capture_output=True,
            env=env,
            cwd=ROOT / "api",
            check=False,
        )
        if proc.returncode != 0:
            print(proc.stdout)
            print(proc.stderr, file=sys.stderr)
            fail(f"reset tool exited with {proc.returncode}")

        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT setup_complete, admin_token_hash, admin_token_version FROM admin_config WHERE id = 1").fetchone()
        conn.close()

        if not row:
            fail("admin_config row missing")
        if row["setup_complete"] != 1:
            fail("setup_complete was not forced to 1")
        if row["admin_token_version"] != 8:
            fail(f"admin_token_version was not incremented: {row['admin_token_version']}")
        if not bcrypt.checkpw(PASSWORD.encode(), row["admin_token_hash"].encode()):
            fail("new password hash does not match")

    print("✅ admin password reset tool smoke test passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
