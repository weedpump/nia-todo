#!/usr/bin/env python3
"""Regression test: a fresh database must migrate from 001 to the latest schema."""

import os
import shutil
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


def run_migrations(env: dict[str, str], migrations_dir: Path | None = None):
    setup = "import sys; sys.path.insert(0, 'api'); import migrate; "
    if migrations_dir is not None:
        setup += f"migrate.MIGRATIONS_DIR = __import__('pathlib').Path({str(migrations_dir)!r}); "
    subprocess.run(
        [sys.executable, "-c", setup + "migrate.run_migrations()"],
        cwd=BASE,
        env=env,
        check=True,
    )


def database_snapshot(db: sqlite3.Connection):
    schema = db.execute(
        """SELECT type, name, tbl_name, sql FROM sqlite_master
           WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"""
    ).fetchall()
    rows = {}
    for (table_name,) in db.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ):
        rows[table_name] = db.execute(f'SELECT * FROM "{table_name}" ORDER BY rowid').fetchall()
    return schema, rows


def main():
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        env = os.environ.copy()
        env["NIA_TODO_DATA_DIR"] = str(tmp_path)
        env["NIA_TODO_DB"] = "fresh-migration-test.db"

        run_migrations(env)

        db_path = tmp_path / "fresh-migration-test.db"
        latest = latest_migration_version()
        assert latest == 62, latest
        with sqlite3.connect(db_path) as db:
            db.execute("PRAGMA foreign_keys = ON")
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
            cookbook_columns = {row[1] for row in db.execute("PRAGMA table_info(cookbooks)")}
            assert {"id", "name", "description", "color", "icon", "sort_order", "created_by_user_id", "client_mutation_id"}.issubset(cookbook_columns), cookbook_columns
            assert "archived_at" not in cookbook_columns
            for recipe_table in ("recipes", "recipe_ingredient_groups", "recipe_ingredients", "recipe_steps", "recipe_tags", "recipe_images", "recipe_mutation_receipts"):
                assert db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (recipe_table,)).fetchone(), recipe_table
            receipt_foreign_keys = {(row[2], row[3], row[6]) for row in db.execute("PRAGMA foreign_key_list(cookbook_creation_receipts)")}
            assert ("users", "user_id", "CASCADE") in receipt_foreign_keys
            assert ("cookbooks", "cookbook_id", "SET NULL") in receipt_foreign_keys
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
            assert {"shopping_list_id", "name", "active", "created_by_user_id", "client_mutation_id"}.issubset(shopping_store_columns), shopping_store_columns
            assert "owner_user_id" not in shopping_store_columns, shopping_store_columns
            assert "owner_household_id" not in shopping_store_columns, shopping_store_columns
            assert {"shopping_list_id", "section_id", "name", "quantity_value", "quantity_unit", "completed", "client_mutation_id"}.issubset(shopping_item_columns), shopping_item_columns
            assert {"shopping_item_id", "shopping_store_id", "shopping_list_id", "sort_order"}.issubset(shopping_item_store_columns), shopping_item_store_columns
            assert {"shopping_list_id", "user_id", "hide_empty_sections"}.issubset(shopping_preference_columns), shopping_preference_columns
            assert "selected_store_id" not in shopping_preference_columns, shopping_preference_columns
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
            store_foreign_keys = {
                (row[2], row[3], row[4], row[6])
                for row in db.execute("PRAGMA foreign_key_list(shopping_stores)")
            }
            assert ("shopping_lists", "shopping_list_id", "id", "CASCADE") in store_foreign_keys, store_foreign_keys
            assert ("shopping_lists", "shopping_list_id", "id", "CASCADE") in item_foreign_keys, item_foreign_keys
            assert ("shopping_sections", "section_id", "id", "SET NULL") in item_foreign_keys, item_foreign_keys
            assert ("shopping_stores", "shopping_store_id", "id", "CASCADE") in item_store_foreign_keys, item_store_foreign_keys
            assert ("shopping_stores", "shopping_list_id", "shopping_list_id", "CASCADE") in item_store_foreign_keys, item_store_foreign_keys
            assert ("shopping_items", "shopping_item_id", "id", "CASCADE") in item_store_foreign_keys, item_store_foreign_keys
            assert ("shopping_items", "shopping_list_id", "shopping_list_id", "CASCADE") in item_store_foreign_keys, item_store_foreign_keys

            first_list_id = db.execute("INSERT INTO shopping_lists (name) VALUES ('First')").lastrowid
            second_list_id = db.execute("INSERT INTO shopping_lists (name) VALUES ('Second')").lastrowid
            item_id = db.execute(
                "INSERT INTO shopping_items (shopping_list_id, name) VALUES (?, 'Milk')",
                (first_list_id,),
            ).lastrowid
            store_id = db.execute(
                "INSERT INTO shopping_stores (shopping_list_id, name) VALUES (?, 'REWE')",
                (second_list_id,),
            ).lastrowid
            try:
                db.execute(
                    """INSERT INTO shopping_item_stores
                       (shopping_item_id, shopping_store_id, shopping_list_id)
                       VALUES (?, ?, ?)""",
                    (item_id, store_id, first_list_id),
                )
            except sqlite3.IntegrityError:
                pass
            else:
                raise AssertionError("Cross-list shopping store assignment bypassed database constraints")

        v55_migrations = tmp_path / "migrations-through-55"
        v55_migrations.mkdir()
        for migration in MIGRATIONS_DIR.glob("*.sql"):
            if int(migration.name.split("_", 1)[0]) <= 55:
                shutil.copy2(migration, v55_migrations / migration.name)

        v55_env = env.copy()
        v55_env["NIA_TODO_DB"] = "published-v55-upgrade.db"
        run_migrations(v55_env, v55_migrations)
        v55_db_path = tmp_path / v55_env["NIA_TODO_DB"]
        with sqlite3.connect(v55_db_path) as db:
            owner_id = db.execute("INSERT INTO users (username) VALUES ('v55-owner')").lastrowid
            accepted_id = db.execute("INSERT INTO users (username) VALUES ('v55-accepted')").lastrowid
            pending_id = db.execute("INSERT INTO users (username) VALUES ('v55-pending')").lastrowid
            declined_id = db.execute("INSERT INTO users (username) VALUES ('v55-declined')").lastrowid
            project_id = db.execute(
                "INSERT INTO projects (name, user_id) VALUES ('Published v55 project', ?)",
                (owner_id,),
            ).lastrowid
            legacy_members = (
                (accepted_id, "accepted", "#112233", "2025-01-01T10:00:00Z", "2025-01-02T11:00:00Z", "username"),
                (pending_id, "pending", None, "2025-02-01T10:00:00Z", "2025-02-02T11:00:00Z", "email"),
                (declined_id, "declined", "#abcdef", "2025-03-01T10:00:00Z", "2025-03-02T11:00:00Z", "username"),
            )
            db.executemany(
                """INSERT INTO project_members
                   (project_id, user_id, invited_by, status, user_color, created_at, updated_at, invite_identifier_type)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                [
                    (project_id, user_id, owner_id, status, color, created_at, updated_at, identifier_type)
                    for user_id, status, color, created_at, updated_at, identifier_type in legacy_members
                ],
            )
            db.commit()

        v57_migrations = tmp_path / "migrations-through-57"
        v57_migrations.mkdir()
        for migration in MIGRATIONS_DIR.glob("*.sql"):
            if int(migration.name.split("_", 1)[0]) <= 57:
                shutil.copy2(migration, v57_migrations / migration.name)
        rollback_db_path = tmp_path / "migration-58-rollback.db"
        shutil.copy2(v55_db_path, rollback_db_path)
        rollback_env = env.copy()
        rollback_env["NIA_TODO_DB"] = rollback_db_path.name
        run_migrations(rollback_env, v57_migrations)
        sys.path.insert(0, str(BASE / "api"))
        import migrate as migrate_module

        with sqlite3.connect(rollback_db_path) as db:
            before_failure = database_snapshot(db)
            broken_migration = (
                (MIGRATIONS_DIR / "058_add_household_entity_access.sql").read_text()
                + "\nSELECT * FROM migration_58_forced_failure;\n"
            )
            try:
                migrate_module.apply_household_entity_access_migration(db, broken_migration)
            except sqlite3.OperationalError as error:
                assert "migration_58_forced_failure" in str(error), error
            else:
                raise AssertionError("fault-injected migration 58 unexpectedly succeeded")
            assert database_snapshot(db) == before_failure
            assert db.execute("SELECT version FROM schema_version").fetchone()[0] == 57

            migrate_module.apply_household_entity_access_migration(
                db,
                (MIGRATIONS_DIR / "058_add_household_entity_access.sql").read_text(),
            )
            before_migration_59_failure = database_snapshot(db)
            broken_migration_59 = (
                (MIGRATIONS_DIR / "059_add_shopping_lists.sql").read_text()
                + "\nSELECT * FROM migration_59_forced_failure;\n"
            )
            try:
                migrate_module.apply_atomic_migration(db, broken_migration_59, 59)
            except sqlite3.OperationalError as error:
                assert "migration_59_forced_failure" in str(error), error
            else:
                raise AssertionError("fault-injected migration 59 unexpectedly succeeded")
            assert database_snapshot(db) == before_migration_59_failure
            assert db.execute("SELECT version FROM schema_version").fetchone()[0] == 58
            migrate_module.apply_atomic_migration(
                db, (MIGRATIONS_DIR / "059_add_shopping_lists.sql").read_text(), 59,
            )
            before_migration_60_failure = database_snapshot(db)
            migration_60 = (MIGRATIONS_DIR / "060_add_braindump_module_routes.sql").read_text()
            try:
                migrate_module.apply_atomic_migration(db, migration_60 + "\nSELECT * FROM migration_60_forced_failure;\n", 60)
            except sqlite3.OperationalError as error:
                assert "migration_60_forced_failure" in str(error), error
            else:
                raise AssertionError("fault-injected migration 60 unexpectedly succeeded")
            assert database_snapshot(db) == before_migration_60_failure
            assert db.execute("SELECT version FROM schema_version").fetchone()[0] == 59
            migrate_module.apply_atomic_migration(db, migration_60, 60)
            assert db.execute("SELECT version FROM schema_version").fetchone()[0] == 60
            assert "client_mutation_id" in {row[1] for row in db.execute("PRAGMA table_info(todos)")}
            db.execute("CREATE INDEX migration61_custom_access_index ON entity_access(entity_type, owner_user_id)")
            db.execute("CREATE TRIGGER migration61_custom_access_trigger AFTER UPDATE OF updated_at ON entity_access BEGIN SELECT 1; END")
            existing_access_id = db.execute("SELECT id FROM entity_access WHERE entity_type = 'project' AND entity_id = ?", (project_id,)).fetchone()[0]
            for status in ("left", "removed"):
                grant_user = db.execute("INSERT INTO users (username) VALUES (?)", ("migration61-" + status,)).lastrowid
                db.execute("INSERT INTO entity_access_grants (entity_access_id, user_id, invited_by_user_id, status) VALUES (?, ?, ?, ?)", (existing_access_id, grant_user, owner_id, status))
            db.execute("UPDATE sqlite_sequence SET seq = 1000 WHERE name = 'entity_access'")
            db.commit()
            access_before_61 = db.execute("SELECT * FROM entity_access ORDER BY id").fetchall()
            grants_before_61 = db.execute("SELECT * FROM entity_access_grants ORDER BY id").fetchall()
            before_migration_61_failure = database_snapshot(db)
            migration_61 = (MIGRATIONS_DIR / "061_add_cookbooks.sql").read_text()
            try:
                migrate_module.apply_cookbooks_migration(db, migration_61 + "\nSELECT * FROM migration_61_forced_failure;\n")
            except sqlite3.OperationalError as error:
                assert "migration_61_forced_failure" in str(error), error
            else:
                raise AssertionError("fault-injected migration 61 unexpectedly succeeded")
            assert database_snapshot(db) == before_migration_61_failure
            assert db.execute("SELECT version FROM schema_version").fetchone()[0] == 60
            assert db.execute("PRAGMA foreign_keys").fetchone()[0] == 1
            try:
                migrate_module.apply_cookbooks_migration(db, migration_61 + "\nUPDATE entity_access_grants SET entity_access_id = 987654321;\n")
            except RuntimeError as error:
                assert "foreign-key validation" in str(error), error
            else:
                raise AssertionError("Migration 61 must reject orphaned grants before commit")
            assert database_snapshot(db) == before_migration_61_failure
            migrate_module.apply_cookbooks_migration(db, migration_61)
            assert db.execute("SELECT * FROM entity_access ORDER BY id").fetchall() == access_before_61
            assert db.execute("SELECT * FROM entity_access_grants ORDER BY id").fetchall() == grants_before_61
            assert db.execute("SELECT 1 FROM sqlite_master WHERE name = 'migration61_custom_access_index'").fetchone()
            assert db.execute("SELECT 1 FROM sqlite_master WHERE name = 'migration61_custom_access_trigger'").fetchone()
            cookbook_id = db.execute("INSERT INTO cookbooks (name) VALUES ('Migration cookbook')").lastrowid
            access_id = db.execute("INSERT INTO entity_access (entity_type, entity_id, owner_user_id) VALUES ('cookbook', ?, ?)", (cookbook_id, owner_id)).lastrowid
            assert access_id > 1000, access_id
            try:
                db.execute("INSERT INTO entity_access_grants (entity_access_id, user_id, invited_by_user_id) VALUES (?, ?, ?)", (access_id, accepted_id, pending_id))
            except sqlite3.IntegrityError as error:
                assert "only the entity manager" in str(error), error
            else:
                raise AssertionError("migration 61 must preserve manager-only grant triggers")
            assert db.execute("PRAGMA foreign_key_check").fetchall() == []
            before_migration_62_failure = database_snapshot(db)
            migration_62 = (MIGRATIONS_DIR / "062_add_recipes.sql").read_text()
            try:
                migrate_module.apply_atomic_migration(db, migration_62 + "\nSELECT * FROM migration_62_forced_failure;\n", 62)
            except sqlite3.OperationalError as error:
                assert "migration_62_forced_failure" in str(error), error
            else:
                raise AssertionError("fault-injected migration 62 unexpectedly succeeded")
            assert database_snapshot(db) == before_migration_62_failure
            assert db.execute("SELECT version FROM schema_version").fetchone()[0] == 61
            migrate_module.apply_atomic_migration(db, migration_62, 62)
        run_migrations(v55_env)
        with sqlite3.connect(v55_db_path) as db:
            assert db.execute("SELECT version FROM schema_version").fetchone()[0] == 62
            project_member_columns = {row[1] for row in db.execute("PRAGMA table_info(project_members)")}
            assert "is_direct_access_mirror" not in project_member_columns, project_member_columns
            migrated_grants = db.execute(
                """SELECT grant_row.user_id, grant_row.invited_by_user_id,
                          grant_row.granted_by_user_id, grant_row.status,
                          grant_row.invite_identifier_type, grant_row.created_at, grant_row.updated_at
                   FROM entity_access_grants grant_row
                   JOIN entity_access access ON access.id = grant_row.entity_access_id
                   WHERE access.entity_type = 'project' AND access.entity_id = ?
                   ORDER BY grant_row.user_id""",
                (project_id,),
            ).fetchall()
            assert migrated_grants == [
                (user_id, owner_id, owner_id, status, identifier_type, created_at, updated_at)
                for user_id, status, _color, created_at, updated_at, identifier_type in legacy_members
            ], migrated_grants
            assert db.execute("PRAGMA foreign_key_check").fetchall() == []

    print("✅ Fresh migration test passed")


if __name__ == "__main__":
    main()
