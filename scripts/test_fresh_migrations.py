#!/usr/bin/env python3
"""Regression test: a fresh database must migrate from 001 to the latest schema."""

import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = BASE / "api" / "migrations"


def latest_migration_version() -> int:
    versions = []
    for path in MIGRATIONS_DIR.glob("*.sql"):
        prefix = path.name.split("_", 1)[0]
        if prefix.isdigit():
            versions.append(int(prefix))
    if not versions:
        raise AssertionError("No migration files found")
    return max(versions)


def main():
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        env = os.environ.copy()
        env["NIA_TODO_DATA_DIR"] = str(tmp_path)
        env["NIA_TODO_DB"] = "fresh-migration-test.db"

        subprocess.run(
            [
                sys.executable,
                "-c",
                "import sys; sys.path.insert(0, 'api'); from migrate import run_migrations; run_migrations()",
            ],
            cwd=BASE,
            env=env,
            check=True,
        )

        db_path = tmp_path / "fresh-migration-test.db"
        latest = latest_migration_version()
        with sqlite3.connect(db_path) as db:
            version = db.execute("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").fetchone()[0]
            assert version == latest, (version, latest)

            project_columns = {row[1] for row in db.execute("PRAGMA table_info(projects)")}
            assert "is_inbox" in project_columns, project_columns
            assert "workspace_id" in project_columns, project_columns

            indexes = {row[1] for row in db.execute("PRAGMA index_list(projects)")}
            assert "idx_projects_user_workspace_inbox_unique" in indexes, indexes

            project_members_columns = {row[1] for row in db.execute("PRAGMA table_info(project_members)")}
            assert {"status", "user_color", "updated_at"}.issubset(project_members_columns), project_members_columns

    print("✅ Fresh migration test passed")


if __name__ == "__main__":
    main()
