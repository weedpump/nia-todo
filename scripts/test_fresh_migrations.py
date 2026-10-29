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

            for table_name in ("shopping_lists", "shopping_sections", "shopping_stores", "shopping_items", "shopping_item_stores", "shopping_list_preferences"):
                table = db.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
                    (table_name,),
                ).fetchone()
                assert table == (table_name,), table

            shopping_list_columns = {row[1] for row in db.execute("PRAGMA table_info(shopping_lists)")}
            shopping_section_columns = {row[1] for row in db.execute("PRAGMA table_info(shopping_sections)")}
            shopping_store_columns = {row[1] for row in db.execute("PRAGMA table_info(shopping_stores)")}
            shopping_item_columns = {row[1] for row in db.execute("PRAGMA table_info(shopping_items)")}
            shopping_item_store_columns = {row[1] for row in db.execute("PRAGMA table_info(shopping_item_stores)")}
            shopping_preference_columns = {row[1] for row in db.execute("PRAGMA table_info(shopping_list_preferences)")}
            assert {"name", "sort_order", "created_by_user_id", "client_mutation_id"}.issubset(shopping_list_columns), shopping_list_columns
            assert {"shopping_list_id", "name", "sort_order", "client_mutation_id"}.issubset(shopping_section_columns), shopping_section_columns
            assert {"name", "owner_user_id", "owner_household_id", "active", "client_mutation_id"}.issubset(shopping_store_columns), shopping_store_columns
            assert {"shopping_list_id", "section_id", "name", "quantity_value", "quantity_unit", "completed", "client_mutation_id"}.issubset(shopping_item_columns), shopping_item_columns
            assert {"shopping_item_id", "shopping_store_id", "sort_order"}.issubset(shopping_item_store_columns), shopping_item_store_columns
            assert {"shopping_list_id", "user_id", "selected_store_id", "hide_empty_sections"}.issubset(shopping_preference_columns), shopping_preference_columns
            assert "markets_json" not in shopping_item_columns, shopping_item_columns
            assert "quantity_text" not in shopping_item_columns, shopping_item_columns
            assert "hide_completed" not in shopping_preference_columns, shopping_preference_columns
            assert "archived_at" not in shopping_list_columns, shopping_list_columns

            shopping_section_indexes = {row[1] for row in db.execute("PRAGMA index_list(shopping_sections)")}
            shopping_item_indexes = {row[1] for row in db.execute("PRAGMA index_list(shopping_items)")}
            assert {"idx_shopping_sections_list_order", "idx_shopping_sections_client_mutation"}.issubset(shopping_section_indexes), shopping_section_indexes
            assert {"idx_shopping_items_list_order", "idx_shopping_items_client_mutation"}.issubset(shopping_item_indexes), shopping_item_indexes

            section_foreign_keys = {(row[2], row[3], row[4], row[6]) for row in db.execute("PRAGMA foreign_key_list(shopping_sections)")}
            item_foreign_keys = {(row[2], row[3], row[4], row[6]) for row in db.execute("PRAGMA foreign_key_list(shopping_items)")}
            item_store_foreign_keys = {
                (row[2], row[3], row[4], row[6])
                for row in db.execute("PRAGMA foreign_key_list(shopping_item_stores)")
            }
            assert ("shopping_lists", "shopping_list_id", "id", "CASCADE") in section_foreign_keys, section_foreign_keys
            assert ("shopping_lists", "shopping_list_id", "id", "CASCADE") in item_foreign_keys, item_foreign_keys
            assert ("shopping_sections", "section_id", "id", "SET NULL") in item_foreign_keys, item_foreign_keys
            assert ("shopping_stores", "shopping_store_id", "id", "CASCADE") in item_store_foreign_keys, item_store_foreign_keys

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

        with sqlite3.connect(db_path) as db:
            db.execute("PRAGMA foreign_keys = OFF")
            db.execute("DROP TABLE shopping_item_stores")
            db.execute("""CREATE TABLE shopping_item_stores (
                shopping_item_id INTEGER NOT NULL,
                shopping_store_id INTEGER NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (shopping_item_id, shopping_store_id),
                FOREIGN KEY (shopping_item_id) REFERENCES shopping_items(id) ON DELETE CASCADE,
                FOREIGN KEY (shopping_store_id) REFERENCES shopping_stores(id)
            )""")
            db.execute("CREATE INDEX idx_shopping_item_stores_item_order ON shopping_item_stores(shopping_item_id, sort_order, shopping_store_id)")
            db.execute("UPDATE schema_version SET version = 58")
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
            repaired_item_store_foreign_keys = {
                (row[2], row[3], row[4], row[6])
                for row in db.execute("PRAGMA foreign_key_list(shopping_item_stores)")
            }
            assert (
                "shopping_stores", "shopping_store_id", "id", "CASCADE"
            ) in repaired_item_store_foreign_keys, repaired_item_store_foreign_keys

    print("✅ Fresh migration test passed")


if __name__ == "__main__":
    main()
