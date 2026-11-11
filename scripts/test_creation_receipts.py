#!/usr/bin/env python3
"""Durable Task/Shopping create identities on exclusively disposable databases."""

import asyncio
import contextlib
import io
import os
import sqlite3
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
TEST_ROOT = tempfile.TemporaryDirectory(prefix="nia-creation-receipts-")
os.environ.update({
    "NIA_TODO_DATA_DIR": TEST_ROOT.name,
    "NIA_TODO_DB": str(Path(TEST_ROOT.name) / "unused.db"),
    "NIA_TODO_ATTACHMENT_DIR": str(Path(TEST_ROOT.name) / "attachments"),
    "NIA_TODO_AVATAR_DIR": str(Path(TEST_ROOT.name) / "avatars"),
    "NIA_TODO_BACKUP_DIR": str(Path(TEST_ROOT.name) / "backups"),
    "NIA_TODO_VAPID_KEYS": str(Path(TEST_ROOT.name) / "vapid.json"),
})
sys.path.insert(0, str(ROOT / "api"))

from fastapi import HTTPException
import db as database
import migrate
from db import get_db
from routers import braindump_v2, shopping, todos
from services.entity_access import (
    create_household, grant_entity_access, invite_household_member,
    register_personal_entity, remove_entity_access, remove_household_member,
    respond_to_household_invite,
)
from services.shopping_items import insert_shopping_item


@contextlib.contextmanager
def fixture():
    with tempfile.TemporaryDirectory(dir=TEST_ROOT.name) as directory, \
         patch.object(database, "DB_PATH", Path(directory) / "receipts.db"), \
         patch.object(migrate, "DB_PATH", Path(directory) / "receipts.db"), \
         patch.object(todos, "broadcast_todo_change", new=AsyncMock()), \
         patch.object(todos, "broadcast_change", new=AsyncMock()), \
         patch.object(shopping, "broadcast_change", new=AsyncMock()), \
         patch.object(shopping, "_broadcast_item_change", new=AsyncMock()), \
         patch.object(shopping, "_broadcast_list_change", new=AsyncMock()), \
         patch.object(shopping, "broadcast_sync_to_users", new=AsyncMock()):
        with contextlib.redirect_stdout(io.StringIO()):
            migrate.run_migrations()
        with get_db() as db:
            users = [db.execute("INSERT INTO users(username) VALUES(?)", (f"user-{n}",)).lastrowid for n in range(3)]
            workspaces = [db.execute("INSERT INTO workspaces(name,user_id,is_default) VALUES('Personal',?,1)", (user,)).lastrowid for user in users]
            project = db.execute("INSERT INTO projects(name,user_id,workspace_id) VALUES('Shared',?,?)", (users[0], workspaces[0])).lastrowid
            register_personal_entity(db, "project", project, users[0])
            grant_entity_access(db, "project", project, users[0], users[1])
        listing = asyncio.run(shopping.create_shopping_list(shopping.ShoppingListCreate(name="Shared list"), users[0]))
        with get_db() as db:
            grant_entity_access(db, "shopping_list", listing["id"], users[0], users[1])
        yield SimpleNamespace(users=users, workspaces=workspaces, project=project, listing=listing["id"])


def expect_error(status, operation, *, detail=None):
    try:
        operation()
    except HTTPException as error:
        assert error.status_code == status, (error.status_code, error.detail)
        if detail is not None:
            assert error.detail == detail, error.detail
    else:
        raise AssertionError(f"Expected HTTP {status}")


def child_create(f, kind, cmi, user=None, listing=None):
    actor = f.users[0] if user is None else user
    parent = f.listing if listing is None else listing
    if kind == "shopping_section":
        return asyncio.run(shopping.create_shopping_section(parent, shopping.ShoppingSectionCreate(name="Section", client_mutation_id=cmi), actor))
    if kind == "shopping_store":
        return asyncio.run(shopping.create_shopping_store(shopping.ShoppingStoreCreate(name="Store", shopping_list_id=parent, client_mutation_id=cmi), actor))
    return asyncio.run(shopping.create_shopping_item(parent, shopping.ShoppingItemCreate(name="Item", client_mutation_id=cmi), actor))


def test_deleted_creates_return_content_free_tombstones_and_new_identity_works():
    with fixture() as f:
        actor = f.users[0]
        data = todos.TodoCreate(title="Private task", project_id=f.project, client_mutation_id="task-create")
        first = asyncio.run(todos.create_todo(data, actor))
        assert asyncio.run(todos.create_todo(data, actor))["id"] == first["id"]
        asyncio.run(todos.delete_todo(first["id"], actor))
        expected = {"code": "sync.creationDeleted", "entity_type": "todo", "id": first["id"]}
        expect_error(410, lambda: asyncio.run(todos.create_todo(data, actor)), detail=expected)
        replacement = asyncio.run(todos.create_todo(data.model_copy(update={"client_mutation_id": "new-task"}), actor))
        assert replacement["id"] != first["id"]
        # Mutation IDs are opaque strings; SQLite length() stops at embedded
        # NULs, although these are valid nonempty request strings.
        opaque = data.model_copy(update={"client_mutation_id": "\x00opaque"})
        original = asyncio.run(todos.create_todo(opaque, actor))
        asyncio.run(todos.delete_todo(original["id"], actor))
        expect_error(410, lambda: asyncio.run(todos.create_todo(opaque, actor)))

        for kind, table in (("shopping_section", "shopping_sections"), ("shopping_store", "shopping_stores"), ("shopping_item", "shopping_items")):
            first = child_create(f, kind, "child-create")
            assert child_create(f, kind, "child-create", f.users[1])["id"] == first["id"], "Child identities stay list-scoped"
            if kind == "shopping_store":
                asyncio.run(shopping.delete_shopping_store(first["id"], actor))
                archived = child_create(f, kind, "child-create")
                assert archived["id"] == first["id"] and archived["active"] is False
                with get_db() as db:
                    db.execute("DELETE FROM shopping_stores WHERE id=?", (first["id"],))
            elif kind == "shopping_section":
                asyncio.run(shopping.delete_shopping_section(first["id"], actor))
            else:
                asyncio.run(shopping.update_shopping_item(first["id"], shopping.ShoppingItemUpdate(completed=True), actor))
                asyncio.run(shopping.delete_completed_shopping_items(f.listing, actor))
            expected = {"code": "sync.creationDeleted", "entity_type": kind, "id": first["id"], "shopping_list_id": f.listing}
            expect_error(410, lambda: child_create(f, kind, "child-create"), detail=expected)
            replacement = child_create(f, kind, "new-child")
            assert replacement["id"] != first["id"]
            with get_db() as db:
                assert db.execute(f"SELECT COUNT(*) FROM {table} WHERE client_mutation_id='child-create'").fetchone()[0] == 0

        data = shopping.ShoppingListCreate(name="Private list", client_mutation_id="list-create")
        first = asyncio.run(shopping.create_shopping_list(data, actor))
        assert asyncio.run(shopping.create_shopping_list(data, actor))["id"] == first["id"]
        asyncio.run(shopping.delete_shopping_list(first["id"], actor))
        expect_error(410, lambda: asyncio.run(shopping.create_shopping_list(data, actor)),
                     detail={"code": "sync.creationDeleted", "entity_type": "shopping_list", "id": first["id"]})
        # List identities remain actor-scoped, unlike their children.
        assert asyncio.run(shopping.create_shopping_list(data, f.users[1]))["id"] != first["id"]


def test_replay_rechecks_access_and_missing_parent_never_returns_child_details():
    with fixture() as f:
        owner, member, outsider = f.users
        data = todos.TodoCreate(title="Shared task", project_id=f.project, client_mutation_id="member-task")
        first = asyncio.run(todos.create_todo(data, member))
        item = child_create(f, "shopping_item", "member-item", member)
        with get_db() as db:
            remove_entity_access(db, "project", f.project, owner, member)
            remove_entity_access(db, "shopping_list", f.listing, owner, member)
        expect_error(403, lambda: asyncio.run(todos.create_todo(data, member)))
        expect_error(404, lambda: child_create(f, "shopping_item", "member-item", member))
        expect_error(404, lambda: child_create(f, "shopping_item", "member-item", outsider))
        asyncio.run(todos.delete_todo(first["id"], owner))
        asyncio.run(shopping.delete_shopping_item(item["id"], owner))
        expect_error(404, lambda: child_create(f, "shopping_item", "member-item", member))
        # The same actor's private task receipt can acknowledge its own deletion
        # without returning former shared content or an access snapshot.
        expect_error(410, lambda: asyncio.run(todos.create_todo(data, member)))
        new_list = asyncio.run(shopping.create_shopping_list(shopping.ShoppingListCreate(name="Other"), owner))
        assert child_create(f, "shopping_item", "member-item", listing=new_list["id"])["id"] != item["id"]
        asyncio.run(shopping.delete_shopping_list(f.listing, owner))
        expect_error(404, lambda: child_create(f, "shopping_item", "member-item"))
        with get_db() as db:
            household = create_household(db, "Household", owner)
            invite = invite_household_member(db, household, owner, member)
            respond_to_household_invite(db, invite, member, accept=True)
        data = shopping.ShoppingListCreate(name="Household list", household_id=household, client_mutation_id="member-list")
        household_list = asyncio.run(shopping.create_shopping_list(data, member))
        with get_db() as db:
            remove_household_member(db, household, owner, member)
        expect_error(404, lambda: asyncio.run(shopping.create_shopping_list(data, member)))
        with get_db() as db:
            assert db.execute("SELECT COUNT(*) FROM shopping_lists WHERE id=?", (household_list["id"],)).fetchone()[0] == 1


def test_triggers_cover_batch_writers_and_rollback_with_their_content():
    with fixture() as f:
        actor = f.users[0]
        candidate = braindump_v2.BrainDumpTodoCandidate(title="Batch task", project_id=f.project, client_mutation_id="batch-task")
        with get_db() as db:
            first = braindump_v2._create_todos_from_braindump_candidates(db, actor, [candidate])[0]
        asyncio.run(todos.delete_todo(first["id"], actor))
        def retry_batch():
            with get_db() as db:
                braindump_v2._create_todos_from_braindump_candidates(db, actor, [candidate])
        expect_error(410, retry_batch)
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            item = insert_shopping_item(db, f.listing, actor, name="Batch item", client_mutation_id="batch-item")
            assert insert_shopping_item(db, f.listing, actor, name="Ignored retry", client_mutation_id="batch-item") == item
        asyncio.run(shopping.delete_shopping_item(item, actor))
        def retry_item():
            with get_db() as db:
                db.execute("BEGIN IMMEDIATE")
                insert_shopping_item(db, f.listing, actor, name="Batch retry", client_mutation_id="batch-item")
        expect_error(410, retry_item)
        try:
            with get_db() as db:
                db.execute("BEGIN IMMEDIATE")
                insert_shopping_item(db, f.listing, actor, name="Rolled back", client_mutation_id="rollback-item")
                raise RuntimeError("Rollback after receipt and item")
        except RuntimeError:
            pass
        with get_db() as db:
            assert db.execute("SELECT 1 FROM creation_receipts WHERE client_mutation_id='rollback-item'").fetchone() is None
            assert db.execute("SELECT 1 FROM shopping_items WHERE client_mutation_id='rollback-item'").fetchone() is None
            # Even an unadapted direct INSERT cannot resurrect an old identity.
            try:
                db.execute("INSERT INTO shopping_items(shopping_list_id,name,client_mutation_id) VALUES(?,'Forbidden','batch-item')", (f.listing,))
            except sqlite3.IntegrityError:
                db.rollback()
            else:
                raise AssertionError("Receipt trigger allowed resurrection")
            assert db.execute("PRAGMA foreign_key_check").fetchall() == []


def test_concurrent_lost_reply_retries_create_once_and_stay_deleted():
    with fixture() as f:
        for kind in ("shopping_section", "shopping_store", "shopping_item"):
            with ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(lambda _: child_create(f, kind, "concurrent"), range(4)))
            assert len({row["id"] for row in results}) == 1
            entity_id = results[0]["id"]
            with get_db() as db:
                db.execute(f"DELETE FROM { {'shopping_section':'shopping_sections','shopping_store':'shopping_stores','shopping_item':'shopping_items'}[kind] } WHERE id=?", (entity_id,))
            with ThreadPoolExecutor(max_workers=4) as pool:
                def rejected(_):
                    expect_error(410, lambda: child_create(f, kind, "concurrent"))
                list(pool.map(rejected, range(4)))
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: asyncio.run(todos.create_todo(todos.TodoCreate(title="Concurrent", project_id=f.project, client_mutation_id="concurrent"), f.users[0])), range(4)))
        assert len({row["id"] for row in results}) == 1


def test_migration_backfill_preserves_scopes_and_failed_upgrade_is_atomic():
    sql = (ROOT / "api/migrations/074_add_creation_receipts.sql").read_text()
    with sqlite3.connect(":memory:") as db:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.executescript("""
            CREATE TABLE schema_version(version INTEGER,applied_at TEXT);
            INSERT INTO schema_version VALUES(73,'before');
            CREATE TABLE users(id INTEGER PRIMARY KEY);
            INSERT INTO users VALUES(1),(2);
            CREATE TABLE todos(id INTEGER PRIMARY KEY,client_mutation_user_id INTEGER,client_mutation_id TEXT);
            CREATE TABLE shopping_lists(id INTEGER PRIMARY KEY,created_by_user_id INTEGER,client_mutation_id TEXT);
            CREATE TABLE shopping_sections(id INTEGER PRIMARY KEY,shopping_list_id INTEGER,client_mutation_id TEXT);
            CREATE TABLE shopping_stores(id INTEGER PRIMARY KEY,shopping_list_id INTEGER,client_mutation_id TEXT);
            CREATE TABLE shopping_items(id INTEGER PRIMARY KEY,shopping_list_id INTEGER,client_mutation_id TEXT);
            INSERT INTO todos VALUES(11,1,'same'),(12,2,'same'),(13,NULL,'orphan'),(14,1,NULL),(15,1,'');
            INSERT INTO shopping_lists VALUES(21,1,'same'),(22,2,'same'),(23,NULL,'orphan');
            INSERT INTO shopping_sections VALUES(31,21,'same'),(32,22,'same');
            INSERT INTO shopping_stores VALUES(41,21,'same'),(42,22,'same');
            INSERT INTO shopping_items VALUES(51,21,'same'),(52,22,'same');
        """)
        db.execute("INSERT INTO todos VALUES(16,1,?)", ("\x00opaque",))
        original = tuple(db.iterdump())
        try:
            migrate.apply_atomic_migration(db, sql + "\nSELECT * FROM deliberately_missing_table;", 74)
        except sqlite3.OperationalError:
            pass
        else:
            raise AssertionError("Invalid migration unexpectedly committed")
        assert tuple(db.iterdump()) == original, "Failed migration retained a table, trigger or marker"
        migrate.apply_atomic_migration(db, sql, 74)
        rows = {tuple(row) for row in db.execute("SELECT entity_type,scope_id,client_mutation_id,entity_id,actor_user_id FROM creation_receipts")}
        expected = {("todo", 1, "same", 11, 1), ("todo", 2, "same", 12, 2),
                    ("todo", 1, "\x00opaque", 16, 1),
                    ("shopping_list", 1, "same", 21, 1), ("shopping_list", 2, "same", 22, 2)}
        for kind, ids in (("shopping_section", (31, 32)), ("shopping_store", (41, 42)), ("shopping_item", (51, 52))):
            expected.update((kind, scope, "same", entity_id, None) for scope, entity_id in zip((21, 22), ids))
        assert rows == expected
        assert db.execute("SELECT version FROM schema_version").fetchone()[0] == 74
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
        # Account-scoped receipts disappear with that account; list-scoped
        # receipts remain valid independently of the original creation actor.
        db.execute("DELETE FROM users WHERE id=1")
        assert db.execute("SELECT COUNT(*) FROM creation_receipts WHERE actor_user_id=1").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM creation_receipts WHERE actor_user_id IS NULL").fetchone()[0] == 6


if __name__ == "__main__":
    for name, test in list(globals().items()):
        if name.startswith("test_") and callable(test):
            test()
            print("✅ " + name)
