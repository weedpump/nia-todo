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

            update_state_columns = {row[1] for row in db.execute("PRAGMA table_info(server_update_check_state)")}
            assert {
                "release_json",
                "source",
                "last_success_at",
                "last_check_at",
                "stale",
                "check_error",
            }.issubset(update_state_columns), update_state_columns

            analytics = db.execute("SELECT value FROM app_config WHERE key = 'update_analytics_enabled'").fetchone()
            assert analytics == ("true",), analytics

            subtask_columns = {row[1] for row in db.execute("PRAGMA table_info(todo_subtasks)")}
            comment_columns = {row[1] for row in db.execute("PRAGMA table_info(todo_comments)")}
            assert "client_mutation_id" in subtask_columns, subtask_columns
            assert "client_mutation_id" in comment_columns, comment_columns
            subtask_indexes = {row[1] for row in db.execute("PRAGMA index_list(todo_subtasks)")}
            comment_indexes = {row[1] for row in db.execute("PRAGMA index_list(todo_comments)")}
            assert "idx_todo_subtasks_client_mutation" in subtask_indexes, subtask_indexes
            assert "idx_todo_comments_client_mutation" in comment_indexes, comment_indexes
            workspace_columns = {row[1] for row in db.execute("PRAGMA table_info(workspaces)")}
            user_columns = {row[1] for row in db.execute("PRAGMA table_info(users)")}
            assert "hidden_modules_json" not in workspace_columns, workspace_columns
            assert "disabled_modules_json" in user_columns, user_columns

            for table_name in ("households", "household_members", "entity_access", "entity_access_grants"):
                table = db.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
                    (table_name,),
                ).fetchone()
                assert table == (table_name,), table

            entity_access_columns = {row[1] for row in db.execute("PRAGMA table_info(entity_access)")}
            assert {"entity_type", "entity_id", "owner_user_id", "owner_household_id"}.issubset(entity_access_columns), entity_access_columns
            entity_access_indexes = {row[1] for row in db.execute("PRAGMA index_list(entity_access)")}
            assert {"idx_entity_access_user_owner", "idx_entity_access_household_owner"}.issubset(entity_access_indexes), entity_access_indexes
            household_member_indexes = {row[1] for row in db.execute("PRAGMA index_list(household_members)")}
            assert {
                "idx_household_members_active_user",
                "idx_household_members_household_status",
            }.issubset(household_member_indexes), household_member_indexes

        with sqlite3.connect(db_path) as db:
            db.execute("DROP TABLE dashboard_preferences")
            db.execute("UPDATE schema_version SET version = 53")
            db.commit()

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

        with sqlite3.connect(db_path) as db:
            version = db.execute("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").fetchone()[0]
            assert version == latest, (version, latest)
            table = db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dashboard_preferences'").fetchone()
            assert table == ("dashboard_preferences",), table
            indexes = {row[1] for row in db.execute("PRAGMA index_list(dashboard_preferences)")}
            assert "idx_dashboard_preferences_user" in indexes, indexes
            workspace_columns = {row[1] for row in db.execute("PRAGMA table_info(workspaces)")}
            user_columns = {row[1] for row in db.execute("PRAGMA table_info(users)")}
            assert "hidden_modules_json" not in workspace_columns, workspace_columns
            assert "disabled_modules_json" in user_columns, user_columns

    print("✅ Fresh migration test passed")


if __name__ == "__main__":
    main()
