#!/usr/bin/env python3
"""Serial isolated BrainDump persistence/learning/retry regressions; no live AI/service."""

from __future__ import annotations

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
TEST_ROOT = tempfile.TemporaryDirectory(prefix="nia-braindump-learning-")
os.environ["NIA_TODO_DATA_DIR"] = TEST_ROOT.name
sys.path.insert(0, str(ROOT / "api"))

from fastapi import HTTPException
import db as database
import migrate
from db import get_db
from routers import braindump_v2 as brain
from routers import shopping
from services.braindump_routes import BrainDumpRouteFeedback, apply_module_routes
from services.entity_access import register_personal_entity


@contextlib.contextmanager
def fixture():
    with tempfile.TemporaryDirectory(dir=TEST_ROOT.name) as tmp:
        path = Path(tmp) / "test.db"
        with patch.object(database, "DB_PATH", path), patch.object(migrate, "DB_PATH", path), \
             patch.object(shopping, "_broadcast_item_change", new=AsyncMock()):
            with contextlib.redirect_stdout(io.StringIO()):
                migrate.run_migrations()
            with get_db() as db:
                users, workspaces, projects = [], [], []
                for n in (1, 2):
                    user = db.execute("INSERT INTO users (username, braindump_enabled) VALUES (?, 1)", (f"user-{n}",)).lastrowid
                    workspace = db.execute("INSERT INTO workspaces (name, user_id, is_default) VALUES ('Personal', ?, 1)", (user,)).lastrowid
                    project = db.execute("INSERT INTO projects (name, user_id, workspace_id, is_inbox) VALUES ('Inbox', ?, ?, 1)", (user, workspace)).lastrowid
                    register_personal_entity(db, "project", project, user)
                    users.append(user); workspaces.append(workspace); projects.append(project)
                list_id = db.execute("INSERT INTO shopping_lists (name, created_by_user_id) VALUES ('Groceries', ?)", (users[0],)).lastrowid
                access = register_personal_entity(db, "shopping_list", list_id, users[0])
                section_id = db.execute("INSERT INTO shopping_sections (shopping_list_id, name) VALUES (?, 'Dairy')", (list_id,)).lastrowid
                store_id = db.execute("INSERT INTO shopping_stores (shopping_list_id, name) VALUES (?, 'Market')", (list_id,)).lastrowid
            yield SimpleNamespace(users=users, workspaces=workspaces, projects=projects, list_id=list_id, section_id=section_id, store_id=store_id, access_id=access)


def shopping_feedback(f, **changes):
    return BrainDumpRouteFeedback(original_module_id="shopping", original_shopping_list_id=f.list_id,
                                  original_shopping_section_id=f.section_id, original_shopping_store_ids=[f.store_id],
                                  original_route_present=True, **changes)


def create_item(f, mutation_id="item-1", user=None, feedback=None, name="Milk"):
    return asyncio.run(shopping.create_shopping_item(f.list_id, shopping.ShoppingItemCreate(
        name=name, section_id=f.section_id, store_ids=[f.store_id], quantity_value=0,
        client_mutation_id=mutation_id, braindump_route=feedback,
    ), user if user is not None else f.users[0]))


def task_feedback(**changes):
    return BrainDumpRouteFeedback(original_module_id="tasks", original_project_name="Inbox", original_route_present=True, **changes)


def create_task(f, mutation_id="task-1", user_index=0, feedback=None, title="Call Alex"):
    with get_db() as db:
        return brain._create_todos_from_braindump_candidates(db, f.users[user_index], [brain.BrainDumpTodoCandidate(
            title=title, project_name="Inbox", client_mutation_id=mutation_id, braindump_route=feedback,
        )], f.workspaces[user_index])[0]


def test_migration_preserves_legacy_routes_and_adds_typed_foreign_keys():
    db = sqlite3.connect(":memory:")
    db.executescript("""
        PRAGMA foreign_keys = ON;
        CREATE TABLE users (id INTEGER PRIMARY KEY);
        CREATE TABLE workspaces (id INTEGER PRIMARY KEY);
        CREATE TABLE projects (id INTEGER PRIMARY KEY);
        CREATE TABLE sections (id INTEGER PRIMARY KEY);
        CREATE TABLE shopping_lists (id INTEGER PRIMARY KEY);
        CREATE TABLE shopping_sections (id INTEGER PRIMARY KEY);
        CREATE TABLE shopping_stores (id INTEGER PRIMARY KEY);
        CREATE TABLE todos (id INTEGER PRIMARY KEY, user_id INTEGER);
        INSERT INTO users VALUES (1); INSERT INTO projects VALUES (1);
    """)
    db.executescript((ROOT / "api/migrations/039_add_braindump_route_learning.sql").read_text())
    db.execute("INSERT INTO braindump_route_learning (user_id, token, project_id, hits, last_used_at) VALUES (1, 'milk', 1, 7, 'before')")
    before = db.execute("SELECT * FROM braindump_route_learning").fetchall()
    db.executescript((ROOT / "api/migrations/060_add_braindump_module_routes.sql").read_text())
    assert db.execute("SELECT * FROM braindump_route_learning").fetchall() == before
    assert {"client_mutation_id", "client_mutation_user_id"} <= {row[1] for row in db.execute("PRAGMA table_info(todos)")}
    try:
        db.execute("INSERT INTO braindump_module_route_learning (user_id, token, module_id, shopping_list_id, last_used_at) VALUES (1, 'milk', 'shopping', 999, 'now')")
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError("A Shopping target bypassed its real domain FK")
    assert db.execute("PRAGMA foreign_key_check").fetchall() == []
    db.close()


def test_shopping_retry_records_once_and_preserves_quantity_zero():
    with fixture() as f:
        feedback = shopping_feedback(f)
        first = create_item(f, feedback=feedback)
        with get_db() as db:
            score = db.execute("SELECT SUM(hits) FROM braindump_module_route_learning WHERE user_id = ?", (f.users[0],)).fetchone()[0]
        second = create_item(f, feedback=feedback)
        assert first["id"] == second["id"] and second["quantity_value"] == 0
        with get_db() as db:
            assert db.execute("SELECT COUNT(*) FROM shopping_items").fetchone()[0] == 1
            assert db.execute("SELECT SUM(hits) FROM braindump_module_route_learning WHERE user_id = ?", (f.users[0],)).fetchone()[0] == score
            row = db.execute("SELECT * FROM braindump_module_route_learning").fetchone()
            assert row["project_id"] is None and row["workspace_id"] is None
            assert row["shopping_list_id"] == f.list_id and row["shopping_store_id"] == f.store_id


def test_multi_store_original_feedback_can_be_corrected_to_one_store_or_task():
    with fixture() as f:
        feedback = BrainDumpRouteFeedback(original_module_id="shopping", original_shopping_list_id=f.list_id,
                                         original_shopping_store_ids=[f.store_id, 99999], original_route_present=True)
        item = create_item(f, feedback=feedback)
        assert item["store_ids"] == [f.store_id]
        task = create_task(f, feedback=feedback)
        assert task["project_id"] == f.projects[0]
        with get_db() as db:
            assert db.execute("SELECT COUNT(*) FROM shopping_stores WHERE id = 99999").fetchone()[0] == 0
            assert db.execute("SELECT COUNT(*) FROM braindump_module_route_learning WHERE shopping_store_id = 99999").fetchone()[0] == 0


def test_task_retry_is_user_scoped_and_writer_serialized():
    with fixture() as f:
        feedback = task_feedback()
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(create_task, f, "same-task", 0, feedback) for _ in range(2)]
            first, second = [future.result(timeout=10) for future in futures]
        assert first["id"] == second["id"]
        other = create_task(f, "same-task", user_index=1, feedback=feedback)
        assert other["id"] != first["id"]
        with get_db() as db:
            assert db.execute("SELECT COUNT(*) FROM todos").fetchone()[0] == 2
            assert db.execute("SELECT SUM(hits) FROM braindump_module_route_learning WHERE user_id = ?", (f.users[0],)).fetchone()[0] == 2
            assert db.execute("SELECT SUM(hits) FROM braindump_route_learning WHERE user_id = ?", (f.users[0],)).fetchone()[0] == 2


def test_task_receipt_survives_creator_changes_and_rechecks_current_access():
    with fixture() as f:
        first = create_task(f, "stable-actor", feedback=task_feedback())
        with get_db() as db:
            access = db.execute("SELECT id FROM entity_access WHERE entity_type = 'project' AND entity_id = ?", (f.projects[1],)).fetchone()["id"]
            db.execute("INSERT INTO entity_access_grants (entity_access_id, user_id, status, invited_by_user_id) VALUES (?, ?, 'accepted', ?)",
                       (access, f.users[0], f.users[1]))
            db.execute("UPDATE todos SET user_id = ?, project_id = ? WHERE id = ?", (f.users[1], f.projects[1], first["id"]))
            before = db.execute("SELECT SUM(hits) FROM braindump_module_route_learning WHERE user_id = ?", (f.users[0],)).fetchone()[0]
        replay = create_task(f, "stable-actor", feedback=task_feedback())
        assert replay["id"] == first["id"] and replay["user_id"] == f.users[1]
        with get_db() as db:
            assert db.execute("SELECT client_mutation_user_id FROM todos WHERE id = ?", (first["id"],)).fetchone()[0] == f.users[0]
            assert db.execute("SELECT SUM(hits) FROM braindump_module_route_learning WHERE user_id = ?", (f.users[0],)).fetchone()[0] == before
            db.execute("UPDATE entity_access_grants SET status = 'removed' WHERE entity_access_id = ? AND user_id = ?", (access, f.users[0]))
        for private in (False, True):
            if private:
                with get_db() as db:
                    db.execute("UPDATE todos SET project_id = NULL WHERE id = ?", (first["id"],))
            try:
                create_task(f, "stable-actor", feedback=task_feedback())
            except HTTPException as exc:
                assert exc.status_code == 403
            else:
                raise AssertionError("Receipt replay bypassed current access")
        with get_db() as db:
            assert db.execute("SELECT COUNT(*) FROM todos").fetchone()[0] == 1


def test_cross_module_manual_corrections_teach_actual_targets():
    with fixture() as f:
        create_item(f, feedback=BrainDumpRouteFeedback(original_module_id="tasks", original_route_present=True))
        with get_db() as db:
            ctx = brain._load_braindump_extraction_context(db, f.users[0], f.workspaces[0], ["tasks", "shopping"])
            source = {"candidates": [{"module_id": "tasks", "title": "Milk", "project_name": None, "section_name": None}]}
            learned = brain._apply_learned_routes(db, f.users[0], f.workspaces[0], source, ctx)
            assert learned["candidates"][0]["module_id"] == "shopping", learned
            assert learned["candidates"][0]["shopping_list_id"] == f.list_id
            assert learned["candidates"][0]["shopping_store_ids"] == [f.store_id]
        create_task(f, title="Milk", feedback=shopping_feedback(f))
        with get_db() as db:
            ctx = brain._load_braindump_extraction_context(db, f.users[0], f.workspaces[0], ["tasks", "shopping"])
            source = {"candidates": [{"module_id": "shopping", "title": "Milk", "shopping_list_id": None}]}
            learned = brain._apply_learned_routes(db, f.users[0], f.workspaces[0], source, ctx)
            assert learned["candidates"][0]["module_id"] == "tasks" and learned["candidates"][0]["project_name"] == "Inbox", learned
            assert "shopping_list_id" not in learned["candidates"][0]
            shopping_only = brain._load_braindump_extraction_context(db, f.users[0], 999, ["shopping"])
            assert apply_module_routes(db, f.users[0], None, source, shopping_only)["candidates"][0]["module_id"] == "shopping"


def test_pending_revoked_and_inactive_targets_never_apply_or_replay():
    with fixture() as f:
        with get_db() as db:
            db.execute("INSERT INTO entity_access_grants (entity_access_id, user_id, status, invited_by_user_id) VALUES (?, ?, 'pending', ?)", (f.access_id, f.users[1], f.users[0]))
        try:
            create_item(f, user=f.users[1], feedback=shopping_feedback(f))
        except HTTPException as exc:
            assert exc.status_code == 404
        else:
            raise AssertionError("Pending invite granted item access")
        with get_db() as db:
            db.execute("UPDATE entity_access_grants SET status = 'accepted' WHERE entity_access_id = ? AND user_id = ?", (f.access_id, f.users[1]))
        create_item(f, user=f.users[1], feedback=BrainDumpRouteFeedback(original_module_id="tasks", original_route_present=True))
        with get_db() as db:
            db.execute("UPDATE shopping_stores SET active = 0 WHERE id = ?", (f.store_id,))
            ctx = brain._load_braindump_extraction_context(db, f.users[1], None, ["shopping"])
            source = {"candidates": [{"module_id": "shopping", "title": "Milk", "shopping_list_id": None}]}
            assert apply_module_routes(db, f.users[1], None, source, ctx) == source
            db.execute("UPDATE entity_access_grants SET status = 'removed' WHERE entity_access_id = ? AND user_id = ?", (f.access_id, f.users[1]))
            ctx = brain._load_braindump_extraction_context(db, f.users[1], None, ["shopping"])
            assert apply_module_routes(db, f.users[1], None, source, ctx) == source
        try:
            create_item(f, user=f.users[1], feedback=shopping_feedback(f))
        except HTTPException as exc:
            assert exc.status_code == 404
        else:
            raise AssertionError("Idempotent replay bypassed revoked access")
        with get_db() as db:
            assert db.execute("SELECT COUNT(*) FROM shopping_items").fetchone()[0] == 1


def test_cross_module_learning_never_discards_explicit_type_specific_content():
    with fixture() as f:
        create_item(f, feedback=BrainDumpRouteFeedback(original_module_id="tasks", original_route_present=True))
        with get_db() as db:
            ctx = brain._load_braindump_extraction_context(db, f.users[0], f.workspaces[0], ["tasks", "shopping"])
            for details in [{"deadline": "2026-12-01T12:00:00+01:00"}, {"reminder": "2026-12-01T12:00:00+01:00"},
                            {"recurring_rule": {"frequency": "weekly", "interval": 1}}, {"location_reminder": {"place_id": 1}}]:
                source = {"candidates": [{"module_id": "tasks", "title": "Milk", **details}]}
                assert apply_module_routes(db, f.users[0], f.workspaces[0], source, ctx) == source
        create_task(f, title="Milk", feedback=shopping_feedback(f))
        with get_db() as db:
            ctx = brain._load_braindump_extraction_context(db, f.users[0], f.workspaces[0], ["tasks", "shopping"])
            for details in [{"quantity_value": 0}, {"quantity_value": 2}, {"quantity_unit": "l"}]:
                source = {"candidates": [{"module_id": "shopping", "title": "Milk", "shopping_list_id": None, **details}]}
                assert apply_module_routes(db, f.users[0], f.workspaces[0], source, ctx) == source


def test_strong_learning_preserves_spoken_list_section_store_and_explicit_empty_routes():
    with fixture() as f:
        create_item(f, feedback=BrainDumpRouteFeedback(original_module_id="tasks", original_route_present=True))
        with get_db() as db:
            other_list = db.execute("INSERT INTO shopping_lists (name, created_by_user_id) VALUES ('Private list', ?)", (f.users[0],)).lastrowid
            register_personal_entity(db, "shopping_list", other_list, f.users[0])
            other_section = db.execute("INSERT INTO shopping_sections (shopping_list_id, name) VALUES (?, 'Bakery')", (f.list_id,)).lastrowid
            other_store = db.execute("INSERT INTO shopping_stores (shopping_list_id, name) VALUES (?, 'Other market')", (f.list_id,)).lastrowid
            ctx = brain._load_braindump_extraction_context(db, f.users[0], f.workspaces[0], ["tasks", "shopping"])
            cases = [
                ({"shopping_list_id": other_list}, "Milk on Private list.", []),
                ({"shopping_list_id": f.list_id, "shopping_section_id": other_section}, "Milk in Bakery.", []),
                ({"shopping_list_id": f.list_id, "shopping_store_ids": [other_store]}, "Milk at Other market.", []),
                ({"shopping_list_id": f.list_id, "shopping_section_id": None, "shopping_store_ids": []}, "Milk without a section or store.", ["section", "stores"]),
            ]
            for fields, transcript, provenance in cases:
                source = brain._normalize_braindump_json({"candidates": [{"module_id": "shopping", "title": "Milk", "explicit_route_fields": provenance, **fields}]}, transcript, ctx)
                assert brain._apply_learned_routes(db, f.users[0], f.workspaces[0], source, ctx) == source, (transcript, source)
            for metadata in ({}, {"explicit_route_fields": None}, {"explicit_route_fields": ["unknown"]}):
                raw = {"module_id": "shopping", "title": "Milk", "shopping_list_id": f.list_id, "shopping_section_id": None, "shopping_store_ids": [], **metadata}
                source = brain._normalize_braindump_json({"candidates": [raw]}, "Milk without a section or store.", ctx)
                assert brain._apply_learned_routes(db, f.users[0], f.workspaces[0], source, ctx) == source, source
            # A semantic destination can still be corrected by learned history.
            source = brain._normalize_braindump_json({"candidates": [{"module_id": "shopping", "title": "Milk", "shopping_list_id": other_list, "explicit_route_fields": []}]}, "We need milk.", ctx)
            learned = brain._apply_learned_routes(db, f.users[0], f.workspaces[0], source, ctx)
            assert learned["candidates"][0]["shopping_list_id"] == f.list_id and learned["candidates"][0]["shopping_store_ids"] == [f.store_id], learned
            # Explicit container selection does not prevent filling inferred children in that container.
            source = brain._normalize_braindump_json({"candidates": [{"module_id": "shopping", "title": "Milk", "shopping_list_id": f.list_id, "explicit_route_fields": ["container"]}]}, "We need milk.", ctx)
            learned = brain._apply_learned_routes(db, f.users[0], f.workspaces[0], source, ctx)
            assert learned["candidates"][0]["shopping_section_id"] == f.section_id and learned["candidates"][0]["shopping_store_ids"] == [f.store_id]


def test_both_task_learners_preserve_explicit_projects_and_sections_but_correct_inference():
    with fixture() as f:
        create_task(f, title="Milk", feedback=BrainDumpRouteFeedback(original_module_id="shopping", original_route_present=True))
        with get_db() as db:
            other_project = db.execute("INSERT INTO projects (name, user_id, workspace_id) VALUES ('Work', ?, ?)", (f.users[0], f.workspaces[0])).lastrowid
            register_personal_entity(db, "project", other_project, f.users[0])
            db.execute("INSERT INTO sections (project_id, name) VALUES (?, 'Calls')", (f.projects[0],))
            db.execute("UPDATE braindump_route_learning SET hits = 10 WHERE user_id = ?", (f.users[0],))
            ctx = brain._load_braindump_extraction_context(db, f.users[0], f.workspaces[0], ["tasks", "shopping"])
            for route, transcript in [({"project_name": "Work"}, "Milk for Work."), ({"project_name": "Inbox", "section_name": "Calls"}, "Milk in Calls.")]:
                source = brain._normalize_braindump_json({"candidates": [{"module_id": "tasks", "title": "Milk", "explicit_route_fields": [], **route}]}, transcript, ctx)
                assert brain._apply_learned_routes(db, f.users[0], f.workspaces[0], source, ctx) == source, (transcript, source)
            inferred = brain._normalize_braindump_json({"candidates": [{"module_id": "tasks", "title": "Milk", "project_name": "Work", "explicit_route_fields": []}]}, "We need milk.", ctx)
            assert brain._apply_learned_routes(db, f.users[0], f.workspaces[0], inferred, ctx)["candidates"][0]["project_name"] == "Inbox"
            old_provider = brain._normalize_braindump_json({"candidates": [{"module_id": "tasks", "title": "Milk", "project_name": "Work"}]}, "We need milk.", ctx)
            assert brain._apply_learned_routes(db, f.users[0], f.workspaces[0], old_provider, ctx) == old_provider
            learned_section = db.execute("SELECT id FROM sections WHERE project_id = ? AND name = 'Calls'", (f.projects[0],)).fetchone()["id"]
            db.execute("UPDATE braindump_route_learning SET section_id = ? WHERE user_id = ?", (learned_section, f.users[0]))
            db.execute("UPDATE braindump_module_route_learning SET task_section_id = ? WHERE user_id = ?", (learned_section, f.users[0]))
            for metadata in ({}, {"explicit_route_fields": None}, {"explicit_route_fields": ["unknown"]}):
                raw = {"module_id": "tasks", "title": "Milk", "project_name": "Inbox", "section_name": None, **metadata}
                source = brain._normalize_braindump_json({"candidates": [raw]}, "Milk without a section.", ctx)
                assert brain._apply_learned_routes(db, f.users[0], f.workspaces[0], source, ctx) == source, source
            source = brain._normalize_braindump_json({"candidates": [{**raw, "explicit_route_fields": []}]}, "We need milk.", ctx)
            assert brain._apply_learned_routes(db, f.users[0], f.workspaces[0], source, ctx)["candidates"][0]["section_name"] == "Calls"


def test_typed_legacy_task_learning_requires_unique_confirmation_names():
    with fixture() as f:
        with get_db() as db:
            duplicate_project = db.execute("INSERT INTO projects (name, user_id, workspace_id) VALUES ('Inbox', ?, ?)", (f.users[0], f.workspaces[0])).lastrowid
            register_personal_entity(db, "project", duplicate_project, f.users[0])
            db.execute("INSERT INTO braindump_route_learning (user_id, workspace_id, token, project_id, section_id, hits, last_used_at) VALUES (?, ?, 'milk', ?, NULL, 10, 'now')", (f.users[0], f.workspaces[0], f.projects[0]))
            ctx = brain._load_braindump_extraction_context(db, f.users[0], f.workspaces[0], ["tasks"])
            source = brain._normalize_braindump_json({"candidates": [{"module_id": "tasks", "title": "Milk", "explicit_route_fields": []}]}, "We need milk.", ctx)
            assert brain._apply_learned_routes(db, f.users[0], f.workspaces[0], source, ctx) == source
            legacy_ctx = {**ctx, "typed_candidates": False}
            legacy = brain._normalize_braindump_json({"candidates": [{"title": "Milk"}]}, "We need milk.", legacy_ctx)
            assert brain._apply_learned_routes(db, f.users[0], f.workspaces[0], legacy, legacy_ctx)["candidates"][0]["project_name"] == "Inbox", "Legacy routing compatibility must remain unchanged"
            db.execute("UPDATE projects SET name = 'Other' WHERE id = ?", (duplicate_project,))
            learned_section = db.execute("INSERT INTO sections (project_id, name) VALUES (?, 'Calls')", (f.projects[0],)).lastrowid
            duplicate_section = db.execute("INSERT INTO sections (project_id, name) VALUES (?, 'Calls')", (f.projects[0],)).lastrowid
            db.execute("UPDATE braindump_route_learning SET section_id = ? WHERE user_id = ?", (learned_section, f.users[0]))
            ctx = brain._load_braindump_extraction_context(db, f.users[0], f.workspaces[0], ["tasks"])
            source = brain._normalize_braindump_json({"candidates": [{"module_id": "tasks", "title": "Milk", "project_name": "Inbox", "explicit_route_fields": []}]}, "We need milk.", ctx)
            assert brain._apply_learned_routes(db, f.users[0], f.workspaces[0], source, ctx) == source
            db.execute("DELETE FROM sections WHERE id = ?", (duplicate_section,))
            ctx = brain._load_braindump_extraction_context(db, f.users[0], f.workspaces[0], ["tasks"])
            assert brain._apply_learned_routes(db, f.users[0], f.workspaces[0], source, ctx)["candidates"][0]["section_name"] == "Calls"


def test_learned_task_targets_respect_inherited_project_access_and_revocation():
    with fixture() as f:
        with get_db() as db:
            child = db.execute("INSERT INTO projects (name, user_id, workspace_id, parent_id) VALUES ('Child', ?, ?, ?)",
                               (f.users[0], f.workspaces[0], f.projects[0])).lastrowid
            register_personal_entity(db, "project", child, f.users[0])
            parent_access = db.execute("SELECT id FROM entity_access WHERE entity_type = 'project' AND entity_id = ?", (f.projects[0],)).fetchone()["id"]
            db.execute("INSERT INTO entity_access_grants (entity_access_id, user_id, status, invited_by_user_id) VALUES (?, ?, 'accepted', ?)",
                       (parent_access, f.users[1], f.users[0]))
        with get_db() as db:
            brain._create_todos_from_braindump_candidates(db, f.users[1], [brain.BrainDumpTodoCandidate(
                title="Milk", project_name="Child", client_mutation_id="inherited",
                braindump_route=BrainDumpRouteFeedback(original_module_id="shopping", original_route_present=True),
            )], f.workspaces[1])
        with get_db() as db:
            source = {"candidates": [{"module_id": "shopping", "title": "Milk", "shopping_list_id": None}]}
            ctx = brain._load_braindump_extraction_context(db, f.users[1], f.workspaces[1], ["tasks", "shopping"])
            result = apply_module_routes(db, f.users[1], f.workspaces[1], source, ctx)
            assert result["candidates"][0]["module_id"] == "tasks" and result["candidates"][0]["project_name"] == "Child", result
            db.execute("UPDATE entity_access_grants SET status = 'removed' WHERE entity_access_id = ? AND user_id = ?", (parent_access, f.users[1]))
            ctx = brain._load_braindump_extraction_context(db, f.users[1], f.workspaces[1], ["tasks", "shopping"])
            assert apply_module_routes(db, f.users[1], f.workspaces[1], source, ctx) == source


def test_rollback_is_atomic_for_shopping_learning_and_task_batches():
    with fixture() as f:
        with patch.object(shopping, "record_confirmed_route", side_effect=RuntimeError("simulated learning failure")):
            try:
                create_item(f, feedback=shopping_feedback(f))
            except RuntimeError:
                pass
            else:
                raise AssertionError("Simulated learning failure was swallowed")
        try:
            with get_db() as db:
                brain._create_todos_from_braindump_candidates(db, f.users[0], [
                    brain.BrainDumpTodoCandidate(title="Valid", project_name="Inbox", client_mutation_id="valid", braindump_route=task_feedback()),
                    brain.BrainDumpTodoCandidate(title="", client_mutation_id="invalid"),
                ], f.workspaces[0])
        except HTTPException:
            pass
        else:
            raise AssertionError("Invalid batch was accepted")
        with get_db() as db:
            assert db.execute("SELECT COUNT(*) FROM shopping_items").fetchone()[0] == 0
            assert db.execute("SELECT COUNT(*) FROM todos").fetchone()[0] == 0
            assert db.execute("SELECT COUNT(*) FROM braindump_module_route_learning").fetchone()[0] == 0
            assert db.execute("SELECT COUNT(*) FROM braindump_route_learning").fetchone()[0] == 0


def test_opt_out_count_reset_and_account_privacy():
    with fixture() as f:
        create_item(f, feedback=shopping_feedback(f))
        create_task(f, feedback=task_feedback())
        create_task(f, mutation_id="other", user_index=1, feedback=task_feedback())
        with get_db() as db:
            assert brain._braindump_learning_settings(db, f.users[0])["learned_routes"] > 0
            other_count = brain._braindump_learning_settings(db, f.users[1])["learned_routes"]
            assert other_count > 0
            assert brain._reset_braindump_learning(db, f.users[0]) > 0
            assert brain._braindump_learning_settings(db, f.users[0])["learned_routes"] == 0
            assert brain._braindump_learning_settings(db, f.users[1])["learned_routes"] == other_count
            db.execute("UPDATE users SET braindump_learning_enabled = 0 WHERE id = ?", (f.users[0],))
        create_item(f, mutation_id="optout", feedback=shopping_feedback(f))
        create_task(f, mutation_id="optout", feedback=task_feedback())
        with get_db() as db:
            assert brain._braindump_learning_settings(db, f.users[0])["learned_routes"] == 0
            ctx = brain._load_braindump_extraction_context(db, f.users[1], f.workspaces[1], ["shopping"])
            assert apply_module_routes(db, f.users[1], None, {"candidates": [{"module_id": "shopping", "title": "Milk", "shopping_list_id": None}]}, ctx)["candidates"][0]["shopping_list_id"] is None


def main():
    tests = [value for name, value in globals().items() if name.startswith("test_") and callable(value)]
    for test in tests:
        test()
        print(f"✅ {test.__name__}")
    print(f"BrainDump Shopping learning and idempotency passed: {len(tests)}/{len(tests)}")


if __name__ == "__main__":
    main()
