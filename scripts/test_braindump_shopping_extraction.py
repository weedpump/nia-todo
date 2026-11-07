#!/usr/bin/env python3
"""Deterministic capability-negotiated BrainDump extraction, without AI/STT calls."""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
TEST_DATA = tempfile.TemporaryDirectory(prefix="nia-braindump-shopping-extract-")
os.environ["NIA_TODO_DATA_DIR"] = TEST_DATA.name
sys.path.insert(0, str(ROOT / "api"))

from pydantic import ValidationError
from fastapi import FastAPI
from fastapi.testclient import TestClient
from routers import braindump_v2 as router
from services.braindump_candidates import enabled_candidate_modules, load_shopping_context
from services.braindump_config import DEFAULT_BRAINDUMP_SYSTEM_PROMPT, build_effective_system_prompt


def make_db():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript("""
        CREATE TABLE users (id INTEGER PRIMARY KEY, disabled_modules_json TEXT NOT NULL DEFAULT '[]', braindump_learning_enabled INTEGER DEFAULT 1);
        CREATE TABLE households (id INTEGER PRIMARY KEY, owner_user_id INTEGER NOT NULL);
        CREATE TABLE household_members (id INTEGER PRIMARY KEY, household_id INTEGER, user_id INTEGER, status TEXT);
        CREATE TABLE entity_access (id INTEGER PRIMARY KEY, entity_type TEXT, entity_id INTEGER, owner_user_id INTEGER, owner_household_id INTEGER);
        CREATE TABLE entity_access_grants (id INTEGER PRIMARY KEY, entity_access_id INTEGER, user_id INTEGER, status TEXT);
        CREATE TABLE shopping_lists (id INTEGER PRIMARY KEY, name TEXT, sort_order INTEGER DEFAULT 0);
        CREATE TABLE shopping_sections (id INTEGER PRIMARY KEY, shopping_list_id INTEGER, name TEXT, sort_order INTEGER DEFAULT 0);
        CREATE TABLE shopping_stores (id INTEGER PRIMARY KEY, shopping_list_id INTEGER, name TEXT, active INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0);
        INSERT INTO users (id) VALUES (1), (2), (3);
        INSERT INTO households VALUES (1, 3), (2, 2), (3, 1);
        INSERT INTO household_members VALUES (1, 1, 1, 'accepted'), (2, 2, 1, 'pending');
        INSERT INTO shopping_lists (id, name) VALUES
            (1, 'Wocheneinkauf'), (2, 'Private list'), (3, 'Accepted list'), (4, 'Pending list'),
            (5, 'Household list'), (6, 'Pending household'), (7, 'Owned household'), (8, 'Duplicate'), (9, 'Duplicate');
        INSERT INTO entity_access VALUES
            (1, 'shopping_list', 1, 1, NULL), (2, 'shopping_list', 2, 2, NULL),
            (3, 'shopping_list', 3, 2, NULL), (4, 'shopping_list', 4, 2, NULL),
            (5, 'shopping_list', 5, NULL, 1), (6, 'shopping_list', 6, NULL, 2),
            (7, 'shopping_list', 7, NULL, 3), (8, 'shopping_list', 8, 1, NULL), (9, 'shopping_list', 9, 1, NULL);
        INSERT INTO entity_access_grants VALUES
            (1, 3, 1, 'accepted'), (2, 4, 1, 'pending'), (3, 6, 1, 'accepted');
        INSERT INTO shopping_sections (id, shopping_list_id, name) VALUES (1, 1, 'Obst'), (2, 2, 'Secret section');
        INSERT INTO shopping_stores (id, shopping_list_id, name, active) VALUES
            (1, 1, 'REWE', 1), (2, 2, 'Private store', 1), (3, 1, 'Inactive store', 0);
    """)
    return db


def context(db, modules=("tasks", "shopping")):
    return {
        "typed_candidates": True, "supported_modules": list(modules),
        "projects": [{"id": 1, "name": "Task project", "sections": ["Task section"]}],
        "places": [], "shopping_lists": load_shopping_context(db, 1) if "shopping" in modules else [],
    }


def normalize(candidates, ctx):
    return router._normalize_braindump_json({"candidates": candidates}, "Mixed deterministic transcript", ctx)["candidates"]


def test_authorized_metadata_only_and_revocation():
    with make_db() as db:
        targets = load_shopping_context(db, 1)
        assert {row["id"] for row in targets} == {1, 3, 5, 7, 8, 9}
        own = next(row for row in targets if row["id"] == 1)
        assert own["sections"] == [{"id": 1, "name": "Obst"}]
        assert own["stores"] == [{"id": 1, "name": "REWE"}]
        assert all(set(row) == {"id", "name", "sections", "stores"} for row in targets)
        # No items/preferences table exists: context must never query their content.
        db.execute("UPDATE entity_access_grants SET status = 'removed' WHERE id = 1")
        db.execute("UPDATE household_members SET status = 'removed' WHERE id = 1")
        assert {row["id"] for row in load_shopping_context(db, 1)} == {1, 7, 8, 9}


def test_requested_and_account_modules_are_intersected():
    with make_db() as db:
        assert enabled_candidate_modules(db, 1, None) == ["tasks"]
        assert enabled_candidate_modules(db, 1, ["shopping"]) == ["shopping"]
        db.execute("UPDATE users SET disabled_modules_json = '[\"shopping\"]' WHERE id = 1")
        assert enabled_candidate_modules(db, 1, ["tasks", "shopping"]) == ["tasks"]
        assert enabled_candidate_modules(db, 1, ["shopping"]) == []
        db.execute("UPDATE users SET disabled_modules_json = '[\"tasks\"]' WHERE id = 1")
        with patch.object(router, "_load_braindump_workspace_context", side_effect=AssertionError("Tasks context was loaded")):
            result = router._load_braindump_extraction_context(db, 1, 9999, ["shopping"])
        assert result["supported_modules"] == ["shopping"]
        assert result["projects"] == [] and result["places"] == [] and result["workspace_id"] is None


def test_mixed_types_and_target_namespaces():
    with make_db() as db:
        result = normalize([
            {"module_id": "tasks", "title": "Milk", "project_name": "Task project", "section_name": "Task section"},
            {"module_id": "shopping", "title": "Milk", "shopping_list_id": 1, "shopping_section_id": 1, "shopping_store_ids": [1], "quantity_value": 0, "quantity_unit": "l", "project_name": "Task project", "deadline": "tomorrow"},
            {"module_id": "shopping", "title": "Milk", "shopping_list_id": 3},
        ], context(db))
        assert len(result) == 3, result
        assert result[0]["module_id"] == "tasks" and result[0]["project_name"] == "Task project"
        shopping = result[1]
        assert shopping["shopping_list_id"] == shopping["shopping_section_id"] == 1
        assert shopping["shopping_store_ids"] == [1] and shopping["quantity_value"] == 0
        assert not {"project_name", "section_name", "deadline", "reminder", "workspace_id"}.intersection(shopping)


def test_unknown_ambiguous_and_cross_list_targets_stay_unresolved():
    with make_db() as db:
        result = normalize([
            {"module_id": "shopping", "title": "A", "shopping_list_name": "Duplicate"},
            {"module_id": "shopping", "title": "B", "shopping_list_id": 2, "shopping_section_id": 2, "shopping_store_ids": [2]},
            {"module_id": "shopping", "title": "C", "shopping_list_id": 1, "shopping_section_id": 2, "shopping_store_ids": [2, 3]},
            {"module_id": "shopping", "title": "D"},
            {"module_id": "shopping", "title": "E", "shopping_list_name": " wocheneinkauf ", "shopping_section_name": "Obst", "shopping_store_name": "rewe"},
        ], context(db))
        assert all(item["shopping_list_id"] is None for item in result[:2] + result[3:4]), result
        assert all(item["shopping_section_id"] is None and item["shopping_store_ids"] == [] for item in result[:4])
        assert result[4]["shopping_list_id"] == result[4]["shopping_section_id"] == 1
        assert result[4]["shopping_store_ids"] == [1]
        empty = normalize([{"module_id": "shopping", "title": "Keep me"}], {"typed_candidates": True, "supported_modules": ["shopping"], "shopping_lists": []})
        assert empty[0]["shopping_list_id"] is None


def test_nonfinite_quantities_and_multilingual_names():
    with make_db() as db:
        result = normalize([
            {"module_id": "shopping", "title": title, "quantity_value": value}
            for title, value in [("牛奶", float("nan")), ("Молоко", float("inf")), ("米饭", -1), ("Яблоки", 0)]
        ], context(db))
        assert len(result) == 4, result
        assert [item["quantity_value"] for item in result] == [None, None, None, 0]
        json.dumps(result, allow_nan=False)


def test_capabilities_and_legacy_shape_cannot_leak_shopping():
    raw = [{"module_id": "shopping", "title": "Milk"}, {"title": "Call Alex"}, {"module_id": "recipes", "title": "Recipe"}]
    with make_db() as db:
        tasks = normalize(raw, context(db, ["tasks"]))
        assert len(tasks) == 1 and tasks[0]["module_id"] == "tasks"
        shopping = normalize(raw, context(db, ["shopping"]))
        assert len(shopping) == 1 and shopping[0]["module_id"] == "shopping"
        legacy = normalize(raw, {"projects": [], "places": []})
        assert len(legacy) == 1 and "module_id" not in legacy[0]
        assert normalize(raw, {"supported_modules": [], "typed_candidates": True}) == []
        for declared in [{"kind": "shopping"}, {"kind": "shopping_item"}, {"module_id": "tasks", "kind": "shopping_item"}]:
            assert normalize([{"title": "Do not disguise as a task", **declared}], context(db)) == []
        assert normalize([{"module_id": "tasks", "title": "Milk", "shopping_list_id": 1}], context(db)) == []


def test_request_and_todo_save_contracts():
    default = router.BrainDumpExtractRequest(transcript="Hi", segment_id=1)
    assert default.supported_modules == ["tasks"] and "supported_modules" not in default.model_fields_set
    explicit = router.BrainDumpExtractRequest(transcript="Hi", segment_id=1, supported_modules=["tasks", "shopping"])
    assert "supported_modules" in explicit.model_fields_set
    for modules in [["recipes"], ["tasks", "shopping", "tasks"], None]:
        try:
            router.BrainDumpExtractRequest(transcript="Hi", segment_id=1, supported_modules=modules)
        except ValidationError:
            pass
        else:
            raise AssertionError(f"Invalid capability list accepted: {modules}")
    for extra in [{"module_id": "shopping"}, {"kind": "shopping_item"}, {"shopping_list_id": 1}, {"module_id": "tasks", "shopping_store_ids": [1]}]:
        try:
            router.BrainDumpCreateTodosRequest(candidates=[{"title": "Milk", **extra}])
        except ValidationError:
            pass
        else:
            raise AssertionError(f"Shopping payload accepted by /todos: {extra}")


def test_prompt_modes_and_full_context_budget():
    assert build_effective_system_prompt({}) == DEFAULT_BRAINDUMP_SYSTEM_PROMPT
    assert build_effective_system_prompt({"system_prompt_mode": "replace", "system_prompt_custom": "Custom only"}, supported_modules=["shopping"]) == "Custom only"
    appended = build_effective_system_prompt({"system_prompt_mode": "append", "system_prompt_custom": "My instruction"}, supported_modules=["tasks", "shopping"])
    assert "shopping_list_id" in appended and appended.endswith("My instruction")
    assert "Output each shopping item as a normal todo candidate" not in appended
    assert '"module_id":"tasks"' in appended and '"module_id":"shopping"' in appended
    assert "Output each shopping item as a normal todo candidate" in DEFAULT_BRAINDUMP_SYSTEM_PROMPT
    assert "module_id" not in DEFAULT_BRAINDUMP_SYSTEM_PROMPT
    with make_db() as db:
        ctx = context(db)
        row = {"id": 1, "name": "X" * 200, "sections": [{"id": n, "name": "S" * 200} for n in range(16)], "stores": [{"id": n, "name": "M" * 120} for n in range(16)]}
        ctx["shopping_lists"] = [dict(row, id=n) for n in range(40)]
        formatted = router._format_workspace_context(ctx)
        assert len(formatted) <= 12000, len(formatted)
        payload = json.loads(formatted)
        assert payload["supported_modules"] == ["tasks", "shopping"] and payload["shopping_lists"]


def test_existing_task_learning_does_not_rewrite_shopping_candidates():
    shopping = {"module_id": "shopping", "title": "Milk", "shopping_list_id": 1, "shopping_section_id": 1, "shopping_store_ids": [1]}
    parsed = {"candidates": [shopping, {"module_id": "tasks", "title": "Call Alex", "project_name": None, "section_name": None}]}
    with patch.object(router, "_learning_enabled_for_user", return_value=True), \
         patch.object(router, "_best_learned_route", return_value=(None, None, 0, 0)) as learn:
        result = router._apply_learned_routes(None, 1, None, parsed)
    assert result["candidates"][0] == shopping
    assert learn.call_count == 1 and learn.call_args.args[3] == "Call Alex"


def test_text_and_combined_audio_negotiate_the_same_contract():
    with make_db() as db:
        @contextmanager
        def db_context():
            yield db

        contexts = []
        def fake_llm(text, segment_id, workspace_context, config):
            contexts.append(workspace_context)
            parsed = router._normalize_braindump_json({"candidates": [{"module_id": "shopping", "title": "Milk", "shopping_list_id": 1}]}, text, workspace_context)
            return 0, parsed, None, json.dumps(parsed)

        class Request:
            headers = {"content-type": "audio/ogg"}
            async def body(self):
                return b"fake audio"

        with patch.object(router, "get_db", db_context), \
             patch.object(router, "require_braindump_access"), \
             patch.object(router, "get_braindump_config", return_value={}), \
             patch.object(router, "_extract_with_llm", side_effect=fake_llm), \
             patch.object(router, "_transcribe_live_audio_bytes", return_value=(0, 0, "Milk", "mock")), \
             patch.object(router, "_apply_learned_routes", side_effect=lambda db, user, workspace, parsed, context=None: parsed), \
             patch.object(router, "increment_endpoint_counter"), \
             patch.object(router, "increment_duration_metric"), \
             patch.object(router, "increment_llm_usage_metrics"), \
             patch.object(router, "_load_braindump_workspace_context", side_effect=AssertionError("Task workspace leaked")):
            text = asyncio.run(router.extract_live_text_segment(Request(), router.BrainDumpExtractRequest(transcript="Milk", segment_id=1, workspace_id=999, supported_modules=["shopping"]), 1))
            audio = asyncio.run(router.process_live_audio_segment(Request(), segment_id=1, audio_start_ms=0, audio_end_ms=0, model="base", workspace_id=999, supported_modules=["shopping"], user_id=1))
        assert text["json"] == audio["json"]
        assert text["json"]["candidates"][0]["module_id"] == "shopping"
        assert contexts[0] == contexts[1] and contexts[0]["projects"] == []


def test_http_validation_rejects_incompatible_contracts_before_side_effects():
    app = FastAPI()
    app.include_router(router.router)
    app.dependency_overrides[router.require_auth] = lambda: 1
    with patch.object(router, "get_db", side_effect=AssertionError("Database must not be reached")), \
         patch.object(router, "require_braindump_access", side_effect=AssertionError("BrainDump access must not be reached")), \
         patch.object(router, "_extract_with_llm", side_effect=AssertionError("LLM must not be reached")), \
         patch.object(router, "_transcribe_live_audio_bytes", side_effect=AssertionError("STT must not be reached")), \
         TestClient(app) as client:
        for modules in [["recipes"], ["tasks", "shopping", "tasks"]]:
            response = client.post("/api/braindump/v2/live/text-segment/extract", json={"transcript": "Milk", "segment_id": 1, "supported_modules": modules})
            assert response.status_code == 422, response.text
        for query in ["supported_modules=recipes", "supported_modules=tasks&supported_modules=shopping&supported_modules=tasks"]:
            response = client.post(f"/api/braindump/v2/live/audio-segment?segment_id=1&{query}", content=b"fake audio")
            assert response.status_code == 422, response.text
        for candidate in [{"module_id": "shopping", "title": "Milk"}, {"module_id": "tasks", "title": "Milk", "shopping_list_id": 1}]:
            response = client.post("/api/braindump/v2/todos", json={"candidates": [candidate]})
            assert response.status_code == 422, response.text


def main():
    tests = [value for name, value in globals().items() if name.startswith("test_") and callable(value)]
    for test in tests:
        test()
        print(f"✅ {test.__name__}")
    print(f"BrainDump Shopping extraction contracts passed: {len(tests)}/{len(tests)}")


if __name__ == "__main__":
    main()
