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
        assert latest == 74, latest
        with sqlite3.connect(db_path) as db:
            db.execute("PRAGMA foreign_keys = ON")
            version = db.execute("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").fetchone()[0]
            assert version == latest, (version, latest)
            assert "origin" in {row[1] for row in db.execute("PRAGMA table_info(recipe_step_ingredients)")}
            assert "excluded_ingredients_json" in {row[1] for row in db.execute("PRAGMA table_info(recipe_steps)")}

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
            assert "routing_memory_generation" in user_columns, user_columns
            for table in ("routing_memory_entries", "routing_memory_events", "routing_memory_observations"):
                assert db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone(), table
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
            for recipe_table in ("recipes", "recipe_ingredient_groups", "recipe_ingredients", "recipe_steps", "recipe_step_ingredients", "recipe_tags", "recipe_images", "recipe_mutation_receipts"):
                assert db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (recipe_table,)).fetchone(), recipe_table
            assert {"quantity_value", "quantity_text"}.issubset({row[1] for row in db.execute("PRAGMA table_info(recipe_step_ingredients)")})
            assert "title" in {row[1] for row in db.execute("PRAGMA table_info(recipe_steps)")}
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
            assert {"quantity_text", "note", "quantity_display_mode"}.issubset(shopping_item_columns), shopping_item_columns
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

        # Published 3.x user deletion left Inbox projects behind: projects.user_id
        # had no FK, so the old database still passed foreign_key_check.
        orphan_db_path = tmp_path / "deleted-user-inbox-upgrade.db"
        shutil.copy2(rollback_db_path, orphan_db_path)
        with sqlite3.connect(orphan_db_path) as db:
            db.execute("PRAGMA foreign_keys = ON")
            orphan_ids = []
            for index in range(8):
                deleted_user = db.execute(
                    "INSERT INTO users (username) VALUES (?)", (f"deleted-legacy-{index}",)
                ).lastrowid
                orphan_ids.append(db.execute(
                    "INSERT INTO projects (name, user_id, is_inbox) VALUES ('Inbox', ?, 1)",
                    (deleted_user,),
                ).lastrowid)
                db.execute("DELETE FROM users WHERE id = ?", (deleted_user,))
            # Even unexpected retained content must survive without acquiring a
            # replacement owner or becoming visible to another account.
            retained_todo = db.execute(
                "INSERT INTO todos (title, project_id) VALUES ('Retained legacy content', ?)",
                (orphan_ids[0],),
            ).lastrowid
            db.commit()
            assert db.execute("PRAGMA foreign_key_check").fetchall() == []
            before_orphan_upgrade = database_snapshot(db)
            migration_58 = (MIGRATIONS_DIR / "058_add_household_entity_access.sql").read_text()
            try:
                migrate_module.apply_household_entity_access_migration(
                    db, migration_58 + f"\nUPDATE entity_access SET owner_user_id = 987654321 WHERE entity_id = {project_id};\n",
                )
            except RuntimeError as error:
                assert "foreign-key validation" in str(error), error
            else:
                raise AssertionError("Migration 58 must still reject unrelated invalid ownership")
            assert database_snapshot(db) == before_orphan_upgrade
            assert db.execute("SELECT version FROM schema_version").fetchone()[0] == 57
            assert db.execute("PRAGMA foreign_keys").fetchone()[0] == 1

            migrate_module.apply_household_entity_access_migration(db, migration_58)
            assert db.execute("SELECT * FROM projects ORDER BY rowid").fetchall() == before_orphan_upgrade[1]["projects"]
            assert db.execute("SELECT * FROM todos ORDER BY rowid").fetchall() == before_orphan_upgrade[1]["todos"]
            assert db.execute("SELECT COUNT(*) FROM entity_access").fetchone()[0] == 1
            assert db.execute("PRAGMA foreign_key_check").fetchall() == []
            db.row_factory = sqlite3.Row
            from services.sharing import can_access_project
            assert can_access_project(db, project_id, owner_id)
            assert can_access_project(db, project_id, accepted_id)
            for orphan_id in orphan_ids:
                for actor_id in (owner_id, accepted_id, pending_id, declined_id):
                    assert not can_access_project(db, orphan_id, actor_id)

        orphan_env = env.copy()
        orphan_env["NIA_TODO_DB"] = orphan_db_path.name
        run_migrations(orphan_env)
        with sqlite3.connect(orphan_db_path) as db:
            assert db.execute("SELECT version FROM schema_version").fetchone()[0] == latest
            assert db.execute("SELECT project_id FROM todos WHERE id = ?", (retained_todo,)).fetchone()[0] == orphan_ids[0]
            assert db.execute(
                """SELECT p.id FROM projects p
                   WHERE p.user_id IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p.user_id)
                   ORDER BY p.id"""
            ).fetchall() == [(orphan_id,) for orphan_id in orphan_ids]
            assert db.execute("PRAGMA foreign_key_check").fetchall() == []

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
            before_migration_63_failure = database_snapshot(db)
            migration_63 = (MIGRATIONS_DIR / "063_add_recipe_shopping_transfers.sql").read_text()
            try:
                migrate_module.apply_atomic_migration(db, migration_63 + "\nSELECT * FROM migration_63_forced_failure;\n", 63)
            except sqlite3.OperationalError as error:
                assert "migration_63_forced_failure" in str(error), error
            else:
                raise AssertionError("fault-injected migration 63 unexpectedly succeeded")
            assert database_snapshot(db) == before_migration_63_failure
            assert db.execute("SELECT version FROM schema_version").fetchone()[0] == 62
            migrate_module.apply_atomic_migration(db, migration_63, 63)
            for table, rows in before_migration_63_failure[1].items():
                current = db.execute(f'SELECT * FROM "{table}" ORDER BY rowid').fetchall()
                if table == "schema_version":
                    continue
                if table == "shopping_items":
                    current = [row[:-2] for row in current]
                assert current == rows, table
            assert {"quantity_text", "note"}.issubset({row[1] for row in db.execute("PRAGMA table_info(shopping_items)")})
            assert db.execute("SELECT COUNT(*) FROM recipe_shopping_transfers").fetchone()[0] == 0
            assert db.execute("SELECT COUNT(*) FROM shopping_item_recipe_sources").fetchone()[0] == 0
            assert db.execute("PRAGMA foreign_key_check").fetchall() == []
            before_migration_64_failure = database_snapshot(db)
            migration_64 = (MIGRATIONS_DIR / "064_add_shopping_quantity_display_mode.sql").read_text()
            try:
                migrate_module.apply_atomic_migration(db, migration_64 + "\nSELECT * FROM migration_64_forced_failure;\n", 64)
            except sqlite3.OperationalError as error:
                assert "migration_64_forced_failure" in str(error), error
            else:
                raise AssertionError("fault-injected migration 64 unexpectedly succeeded")
            assert database_snapshot(db) == before_migration_64_failure
            assert db.execute("SELECT version FROM schema_version").fetchone()[0] == 63
            migrate_module.apply_atomic_migration(db, migration_64, 64)
            for table, rows in before_migration_64_failure[1].items():
                if table == "schema_version":
                    continue
                current = db.execute(f'SELECT * FROM "{table}" ORDER BY rowid').fetchall()
                if table == "shopping_items":
                    assert all(row[-1] == "exact" for row in current)
                    current = [row[:-1] for row in current]
                assert current == rows, table
            # Upgrade existing recipe children without changing their IDs/content.
            recipe_id = db.execute("INSERT INTO recipes (cookbook_id, title, client_mutation_id) VALUES (?, 'Existing recipe', 'migration-existing-recipe')", (cookbook_id,)).lastrowid
            group_id = db.execute("INSERT INTO recipe_ingredient_groups (recipe_id,client_key,name,sort_order) VALUES (?, 'group', 'Existing group', 0)", (recipe_id,)).lastrowid
            db.execute("INSERT INTO recipe_ingredients (recipe_id,group_id,client_key,name,quantity_value,quantity_unit,sort_order) VALUES (?, ?, 'ingredient', 'Flour', 250, 'g', 0)", (recipe_id,group_id))
            db.execute("INSERT INTO recipe_steps (recipe_id,client_key,text,sort_order) VALUES (?, 'step', 'Existing preparation', 0)", (recipe_id,))
            before_migration_65_failure = database_snapshot(db)
            migration_65 = (MIGRATIONS_DIR / "065_add_recipe_step_ingredients.sql").read_text()
            try:
                migrate_module.apply_atomic_migration(db, migration_65 + "\nSELECT * FROM migration_65_forced_failure;\n", 65)
            except sqlite3.OperationalError as error:
                assert "migration_65_forced_failure" in str(error), error
            else:
                raise AssertionError("fault-injected migration 65 unexpectedly succeeded")
            assert database_snapshot(db) == before_migration_65_failure
            assert db.execute("SELECT version FROM schema_version").fetchone()[0] == 64
            migrate_module.apply_atomic_migration(db, migration_65, 65)
            for table, rows in before_migration_65_failure[1].items():
                if table != "schema_version":
                    assert db.execute(f'SELECT * FROM "{table}" ORDER BY rowid').fetchall() == rows, table
            assert db.execute("SELECT COUNT(*) FROM recipe_step_ingredients").fetchone()[0] == 0
            assert db.execute("PRAGMA foreign_key_check").fetchall() == []
            ingredient_id = db.execute("SELECT id FROM recipe_ingredients WHERE recipe_id = ?", (recipe_id,)).fetchone()[0]
            step_id = db.execute("SELECT id FROM recipe_steps WHERE recipe_id = ?", (recipe_id,)).fetchone()[0]
            db.execute("INSERT INTO recipe_step_ingredients(recipe_id,step_id,ingredient_id,show_quantity,sort_order) VALUES (?,?,?,0,0)", (recipe_id, step_id, ingredient_id))
            before_migration_66_failure = database_snapshot(db)
            migration_66 = (MIGRATIONS_DIR / "066_add_recipe_step_quantities.sql").read_text()
            try:
                migrate_module.apply_atomic_migration(db, migration_66 + "\nSELECT * FROM migration_66_forced_failure;\n", 66)
            except sqlite3.OperationalError as error:
                assert "migration_66_forced_failure" in str(error), error
            else:
                raise AssertionError("fault-injected migration 66 unexpectedly succeeded")
            assert database_snapshot(db) == before_migration_66_failure
            assert db.execute("SELECT version FROM schema_version").fetchone()[0] == 65
            migrate_module.apply_atomic_migration(db, migration_66, 66)
            for table, rows in before_migration_66_failure[1].items():
                if table == "schema_version":
                    continue
                current = db.execute(f'SELECT * FROM "{table}" ORDER BY rowid').fetchall()
                if table == "recipe_step_ingredients":
                    assert all(row[-2:] == (None, None) for row in current)
                    current = [row[:-2] for row in current]
                assert current == rows, table
            for value, text, shown in ((0, None, 1), (float("inf"), None, 1), (10, "a little", 1), (10, None, 0), (None, "a little", 0)):
                db.execute("SAVEPOINT invalid_step_quantity")
                try:
                    db.execute("UPDATE recipe_step_ingredients SET quantity_value=?,quantity_text=?,show_quantity=?", (value, text, shown))
                except sqlite3.IntegrityError:
                    pass
                else:
                    raise AssertionError("Step quantity schema accepted invalid numeric/free/legacy state")
                finally:
                    db.execute("ROLLBACK TO invalid_step_quantity")
                    db.execute("RELEASE invalid_step_quantity")
            assert db.execute("PRAGMA foreign_key_check").fetchall() == []
        v70_migrations = tmp_path / "migrations-v70"
        v70_migrations.mkdir()
        for migration in MIGRATIONS_DIR.glob("*.sql"):
            if int(migration.name.split("_", 1)[0]) <= 70:
                shutil.copy2(migration, v70_migrations / migration.name)
        run_migrations(v55_env, v70_migrations)
        with sqlite3.connect(v55_db_path) as db:
            # Earlier recipe fixtures belong to rollback_db_path; seed this
            # published-v55 upgrade database independently before upgrading it.
            db.execute("PRAGMA foreign_keys = ON")
            title_book_id = db.execute("INSERT INTO cookbooks (name) VALUES ('Step title upgrade cookbook')").lastrowid
            recipe_id = db.execute("INSERT INTO recipes (cookbook_id,title,client_mutation_id) VALUES (?, 'Step title upgrade recipe', 'migration-step-title-recipe')", (title_book_id,)).lastrowid
            title_group_id = db.execute("INSERT INTO recipe_ingredient_groups (recipe_id,client_key,name,sort_order) VALUES (?, 'title-group', 'Dough', 0)", (recipe_id,)).lastrowid
            title_ingredient_id = db.execute("INSERT INTO recipe_ingredients (recipe_id,group_id,client_key,name,quantity_value,quantity_unit,sort_order) VALUES (?, ?, 'title-flour', 'Flour', 250, 'g', 0)", (recipe_id, title_group_id)).lastrowid
            title_step_id = db.execute("INSERT INTO recipe_steps (recipe_id,client_key,text,sort_order) VALUES (?, 'step', 'Existing preparation', 0)", (recipe_id,)).lastrowid
            db.execute("INSERT INTO recipe_step_ingredients (recipe_id,step_id,ingredient_id,show_quantity,sort_order,quantity_value) VALUES (?, ?, ?, 1, 0, 25)", (recipe_id, title_step_id, title_ingredient_id))
            db.row_factory = sqlite3.Row
            before_sources = [dict(row) for row in db.execute("SELECT * FROM recipes ORDER BY id")]
        v71_migrations = tmp_path / "migrations-v71"
        v71_migrations.mkdir()
        for migration in MIGRATIONS_DIR.glob("*.sql"):
            if int(migration.name.split("_", 1)[0]) <= 71:
                shutil.copy2(migration, v71_migrations / migration.name)
        # Exercise the startup dispatcher, including failure after the first
        # ALTER and while recording the schema version. Neither may leave a
        # partial source schema that prevents the next startup from retrying.
        with sqlite3.connect(v55_db_path) as db:
            before_source_migration = database_snapshot(db)
            assert db.execute("SELECT version FROM schema_version").fetchone()[0] == 70
        migration_71 = (MIGRATIONS_DIR / "071_add_recipe_sources.sql").read_text()
        failing_v71_migrations = tmp_path / "migrations-v71-failure"
        failing_v71_migrations.mkdir()
        first_alter = "ALTER TABLE recipes ADD COLUMN source_url TEXT NOT NULL DEFAULT '';"
        assert migration_71.count(first_alter) == 1
        (failing_v71_migrations / "071_add_recipe_sources.sql").write_text(
            migration_71.replace(first_alter, first_alter + "\nSELECT * FROM migration_71_dispatch_failure;")
        )
        try:
            run_migrations(v55_env, failing_v71_migrations)
        except subprocess.CalledProcessError as error:
            assert error.returncode != 0
        else:
            raise AssertionError("fault-injected startup migration 71 unexpectedly succeeded")
        with sqlite3.connect(v55_db_path) as db:
            assert database_snapshot(db) == before_source_migration
            assert db.execute("SELECT version FROM schema_version").fetchone()[0] == 70
            db.execute("""CREATE TRIGGER migration71_reject_version
                BEFORE INSERT ON schema_version WHEN NEW.version = 71
                BEGIN SELECT RAISE(ABORT, 'migration_71_version_failure'); END""")
            before_source_version_failure = database_snapshot(db)
        try:
            run_migrations(v55_env, v71_migrations)
        except subprocess.CalledProcessError as error:
            assert error.returncode != 0
        else:
            raise AssertionError("fault-injected migration 71 version write unexpectedly succeeded")
        with sqlite3.connect(v55_db_path) as db:
            assert database_snapshot(db) == before_source_version_failure
            assert db.execute("SELECT version FROM schema_version").fetchone()[0] == 70
            db.execute("DROP TRIGGER migration71_reject_version")
            assert database_snapshot(db) == before_source_migration
        run_migrations(v55_env, v71_migrations)
        with sqlite3.connect(v55_db_path) as db:
            db.execute("PRAGMA foreign_keys = ON")
            existing_texts = {
                "legacy-lf": "Prepare the filling\nSlice the apples.\nKeep the juice.",
                "legacy-crlf": "Prepare the dough\r\nKnead well.\r\nLet it rest.",
                "one-line": "A complete imported instruction without a heading.",
                "long-first-line": "x" * 201 + "\nThis body must remain unchanged.",
                "blank-rest": "Only a heading\n \t\r\n",
                "blank-first-line": "\nAn instruction without a heading.",
            }
            for position, (key, text) in enumerate(existing_texts.items(), 1):
                db.execute("INSERT INTO recipe_steps (recipe_id, client_key, text, sort_order) VALUES (?, ?, ?, ?)", (recipe_id, key, text, position))
            deleted_step = db.execute("INSERT INTO recipe_steps (recipe_id,client_key,text,sort_order) VALUES (?, 'deleted-highest', 'Deleted', 99)", (recipe_id,)).lastrowid
            db.execute("DELETE FROM recipe_steps WHERE id = ?", (deleted_step,))
            db.commit()
            before_title_migration = database_snapshot(db)
            db.row_factory = sqlite3.Row
            before_steps = [dict(row) for row in db.execute("SELECT * FROM recipe_steps ORDER BY id")]
            db.row_factory = None
            migration_72 = (MIGRATIONS_DIR / "072_add_recipe_step_titles.sql").read_text()
            try:
                migrate_module.apply_atomic_migration(db, migration_72 + "\nSELECT * FROM migration_72_forced_failure;\n", 72)
            except sqlite3.OperationalError as error:
                assert "migration_72_forced_failure" in str(error), error
            else:
                raise AssertionError("fault-injected migration 72 unexpectedly succeeded")
            assert database_snapshot(db) == before_title_migration
            assert db.execute("SELECT version FROM schema_version").fetchone()[0] == 71
        # Exercise the real startup dispatcher too: a direct atomic-helper test
        # would miss accidentally routing this rebuild through executescript.
        failing_v72_migrations = tmp_path / "migrations-v72-failure"
        failing_v72_migrations.mkdir()
        (failing_v72_migrations / "072_add_recipe_step_titles.sql").write_text(
            migration_72 + "\nSELECT * FROM migration_72_dispatch_failure;\n"
        )
        try:
            run_migrations(v55_env, failing_v72_migrations)
        except subprocess.CalledProcessError as error:
            assert error.returncode != 0
        else:
            raise AssertionError("fault-injected startup migration 72 unexpectedly succeeded")
        with sqlite3.connect(v55_db_path) as db:
            assert database_snapshot(db) == before_title_migration
            assert db.execute("SELECT version FROM schema_version").fetchone()[0] == 71
        v72_migrations = tmp_path / "migrations-v72"
        v72_migrations.mkdir()
        for migration in MIGRATIONS_DIR.glob("*.sql"):
            if int(migration.name.split("_", 1)[0]) <= 72:
                shutil.copy2(migration, v72_migrations / migration.name)
        run_migrations(v55_env, v72_migrations)
        with sqlite3.connect(v55_db_path) as db:
            db.execute("PRAGMA foreign_keys = ON")
            db.row_factory = sqlite3.Row
            after_sources = [dict(row) for row in db.execute("SELECT * FROM recipes ORDER BY id")]
            fields = {"source_url", "source_name", "source_author", "source_yield"}
            assert [{key: value for key, value in row.items() if key not in fields} for row in after_sources] == before_sources
            assert all(row[field] == "" for row in after_sources for field in fields)
            db.row_factory = None
            assert db.execute("SELECT version FROM schema_version").fetchone()[0] == 72
            db.row_factory = sqlite3.Row
            after_steps = [dict(row) for row in db.execute("SELECT * FROM recipe_steps ORDER BY id")]
            db.row_factory = None
            expected_steps = []
            for step in before_steps:
                if step["client_key"] in {"legacy-lf", "legacy-crlf"}:
                    title, body = step["text"].split("\n", 1)
                    step = {**step, "title": title.rstrip("\r"), "text": body}
                else:
                    step = {**step, "title": ""}
                expected_steps.append(step)
            assert after_steps == expected_steps
            for table, rows in before_title_migration[1].items():
                if table not in {"schema_version", "recipe_steps"}:
                    assert db.execute(f'SELECT * FROM "{table}" ORDER BY rowid').fetchall() == rows, table
            title_only_id = db.execute("INSERT INTO recipe_steps (recipe_id,client_key,title,text,sort_order) VALUES (?, 'title-only', 'Serve', '', 100)", (recipe_id,)).lastrowid
            assert title_only_id > deleted_step, "Rebuilding steps must preserve the AUTOINCREMENT high-water mark"
            for title, body in (("", ""), (" \n", "\t"), ("x" * 201, "Body"), ("Title", "x" * 8001)):
                try:
                    db.execute("INSERT INTO recipe_steps (recipe_id,client_key,title,text,sort_order) VALUES (?, 'invalid-step', ?, ?, 101)", (recipe_id, title, body))
                except sqlite3.IntegrityError:
                    pass
                else:
                    raise AssertionError("Step title/body schema accepted invalid content")
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

        # Provenance migration adds only conservative metadata to existing
        # author content; both ALTERs and the version marker must roll back.
        with sqlite3.connect(v55_db_path) as db:
            db.execute("PRAGMA foreign_keys = ON")
            before_provenance = database_snapshot(db)
            assert db.execute("SELECT version FROM schema_version").fetchone()[0] == 72
            migration_73 = (MIGRATIONS_DIR / "073_add_recipe_assignment_provenance.sql").read_text()
            try:
                migrate_module.apply_atomic_migration(db, migration_73 + "\nSELECT * FROM migration_73_forced_failure;\n", 73)
            except sqlite3.OperationalError as error:
                assert "migration_73_forced_failure" in str(error), error
            else:
                raise AssertionError("fault-injected migration 73 unexpectedly succeeded")
            assert database_snapshot(db) == before_provenance
            assert db.execute("SELECT version FROM schema_version").fetchone()[0] == 72
        failing_v73_migrations = tmp_path / "migrations-v73-failure"
        failing_v73_migrations.mkdir()
        (failing_v73_migrations / "073_add_recipe_assignment_provenance.sql").write_text(
            migration_73 + "\nSELECT * FROM migration_73_dispatch_failure;\n"
        )
        try:
            run_migrations(v55_env, failing_v73_migrations)
        except subprocess.CalledProcessError as error:
            assert error.returncode != 0
        else:
            raise AssertionError("fault-injected startup migration 73 unexpectedly succeeded")
        with sqlite3.connect(v55_db_path) as db:
            assert database_snapshot(db) == before_provenance
            assert db.execute("SELECT version FROM schema_version").fetchone()[0] == 72
        v73_migrations = tmp_path / "migrations-v73"
        v73_migrations.mkdir()
        for migration in MIGRATIONS_DIR.glob("*.sql"):
            if int(migration.name.split("_", 1)[0]) <= 73:
                shutil.copy2(migration, v73_migrations / migration.name)
        run_migrations(v55_env, v73_migrations)
        with sqlite3.connect(v55_db_path) as db:
            assert db.execute("SELECT version FROM schema_version").fetchone()[0] == 73
            assert all(row[0] == "manual" for row in db.execute("SELECT origin FROM recipe_step_ingredients"))
            assert all(row[0] == "[]" for row in db.execute("SELECT excluded_ingredients_json FROM recipe_steps"))
            for table, rows in before_provenance[1].items():
                if table == "schema_version":
                    continue
                current = db.execute(f'SELECT * FROM "{table}" ORDER BY rowid').fetchall()
                if table in {"recipe_steps", "recipe_step_ingredients"}:
                    current = [row[:-1] for row in current]
                assert current == rows, table
            for statement, value in (
                ("UPDATE recipe_step_ingredients SET origin=?", "llm"),
                ("UPDATE recipe_step_ingredients SET origin=?", None),
                ("UPDATE recipe_steps SET excluded_ingredients_json=?", "{}"),
                ("UPDATE recipe_steps SET excluded_ingredients_json=?", "null"),
                ("UPDATE recipe_steps SET excluded_ingredients_json=?", "[" + ",".join('"x"' for _ in range(501)) + "]"),
            ):
                db.execute("SAVEPOINT invalid_assignment_metadata")
                try:
                    db.execute(statement, (value,))
                except sqlite3.IntegrityError:
                    pass
                else:
                    raise AssertionError("Assignment metadata schema accepted invalid content")
                finally:
                    db.execute("ROLLBACK TO invalid_assignment_metadata")
                    db.execute("RELEASE invalid_assignment_metadata")
            assert db.execute("PRAGMA foreign_key_check").fetchall() == []

        with sqlite3.connect(v55_db_path) as db:
            before_creation_receipts = database_snapshot(db)
        migration_74 = (MIGRATIONS_DIR / "074_add_creation_receipts.sql").read_text()
        failing_v74 = tmp_path / "migrations-v74-failure"
        failing_v74.mkdir()
        (failing_v74 / "074_add_creation_receipts.sql").write_text(
            migration_74 + "\nSELECT * FROM migration_74_dispatch_failure;\n"
        )
        for migrations_dir in (failing_v74, MIGRATIONS_DIR):
            with sqlite3.connect(v55_db_path) as db:
                if migrations_dir == MIGRATIONS_DIR:
                    db.execute("""CREATE TRIGGER migration74_reject_version
                        BEFORE INSERT ON schema_version WHEN NEW.version = 74
                        BEGIN SELECT RAISE(ABORT, 'migration_74_version_failure'); END""")
                before_failure = database_snapshot(db)
            try:
                run_migrations(v55_env, migrations_dir)
            except subprocess.CalledProcessError:
                pass
            else:
                raise AssertionError("fault-injected startup migration 74 unexpectedly succeeded")
            with sqlite3.connect(v55_db_path) as db:
                assert database_snapshot(db) == before_failure
                assert db.execute("SELECT version FROM schema_version").fetchone()[0] == 73
                if migrations_dir == MIGRATIONS_DIR:
                    db.execute("DROP TRIGGER migration74_reject_version")
                assert database_snapshot(db) == before_creation_receipts
        run_migrations(v55_env)
        with sqlite3.connect(v55_db_path) as db:
            assert db.execute("SELECT version FROM schema_version").fetchone()[0] == latest
            assert db.execute("SELECT name FROM sqlite_master WHERE name='creation_receipts'").fetchone()
            for table, rows in before_creation_receipts[1].items():
                if table != "schema_version":
                    assert db.execute(f'SELECT * FROM "{table}" ORDER BY rowid').fetchall() == rows, table
            assert db.execute("PRAGMA foreign_key_check").fetchall() == []

    print("✅ Fresh migration test passed")


if __name__ == "__main__":
    main()
