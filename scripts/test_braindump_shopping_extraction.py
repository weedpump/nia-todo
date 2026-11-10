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
from services.braindump_candidates import can_apply_learned_route, enabled_candidate_modules, load_shopping_context
from services.braindump_config import DEFAULT_BRAINDUMP_SYSTEM_PROMPT, build_effective_system_prompt
from services import braindump_config as config_service


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


def shopping_routing_context():
    return {
        "typed_candidates": True, "supported_modules": ["shopping"], "projects": [], "places": [],
        "shopping_lists": [
            {"id": 1, "name": "Bla", "sections": [{"id": 1, "name": "Other"}], "stores": [{"id": 1, "name": "REWE"}]},
            {"id": 2, "name": "Einkauf", "sections": [{"id": 4, "name": "Obst & Gemüse"}, {"id": 5, "name": "Kühlregal"}], "stores": [{"id": 3, "name": "REWE"}]},
        ],
    }


def test_missing_list_is_inferred_only_from_consistent_authorized_child_hints():
    ctx = shopping_routing_context()
    result = normalize([
        {"module_id": "shopping", "title": "Milch", "shopping_list_id": None, "shopping_section_id": 5},
        {"module_id": "shopping", "title": "Joghurt", "shopping_section_name": " kühlregal "},
        {"module_id": "shopping", "title": "Brot", "shopping_store_ids": [3]},
        {"module_id": "shopping", "title": "Äpfel", "shopping_section_id": 4, "shopping_store_name": "REWE"},
    ], ctx)
    assert [item["shopping_list_id"] for item in result] == [2, 2, 2, 2], result
    assert result[0]["shopping_section_id"] == result[1]["shopping_section_id"] == 5
    assert result[2]["shopping_store_ids"] == [3]
    assert result[3]["shopping_section_id"] == 4 and result[3]["shopping_store_ids"] == [3]


def test_parent_inference_never_repairs_explicit_wrong_ids_or_conflicting_hints():
    ctx = shopping_routing_context()
    rows = [
        {"shopping_list_id": 999, "shopping_section_id": 5},
        {"shopping_list_name": "Unknown list", "shopping_section_id": 5},
        {"shopping_section_id": 999, "shopping_store_ids": [3]},
        {"shopping_section_id": 5, "shopping_store_ids": [1]},
        {"shopping_store_ids": [1, 3]},
        {"shopping_store_name": "REWE"},
        {},
    ]
    for route in rows:
        item = normalize([{"module_id": "shopping", "title": "Milch", **route}], ctx)[0]
        assert item["shopping_list_id"] is None and item["shopping_section_id"] is None and item["shopping_store_ids"] == [], (route, item)
    explicit = normalize([{"module_id": "shopping", "title": "Milch", "shopping_list_id": 1, "shopping_section_id": 5}], ctx)[0]
    assert explicit["shopping_list_id"] == 1 and explicit["shopping_section_id"] is None
    sole_list = {**ctx, "shopping_lists": [ctx["shopping_lists"][1]]}
    assert normalize([{"module_id": "shopping", "title": "Milch"}], sole_list)[0]["shopping_list_id"] is None
    ambiguous_section = {**ctx, "shopping_lists": [{**row, "sections": [{"id": 20 + row["id"], "name": "Kühlregal"}]} for row in ctx["shopping_lists"]]}
    assert normalize([{"module_id": "shopping", "title": "Milch", "shopping_section_name": "Kühlregal"}], ambiguous_section)[0]["shopping_list_id"] is None


def test_explicit_route_provenance_is_sanitized_and_literal_names_are_protected():
    ctx = shopping_routing_context()
    raw = {"module_id": "shopping", "title": "Milch", "shopping_list_id": 2, "shopping_section_id": 5, "shopping_store_ids": [3], "explicit_route_fields": []}
    spoken = router._normalize_braindump_json({"candidates": [raw]}, "Milch auf EINKAUF im Kühlregal bei Rewe.", ctx)["candidates"][0]
    assert spoken["explicit_route_fields"] == ["container", "section", "stores"], spoken
    inferred = router._normalize_braindump_json({"candidates": [raw]}, "Wir brauchen Milch.", ctx)["candidates"][0]
    assert inferred["explicit_route_fields"] == [], inferred
    old_provider = normalize([{key: value for key, value in raw.items() if key != "explicit_route_fields"}], ctx)[0]
    assert old_provider["explicit_route_fields"] == ["container", "section", "stores"]
    malformed = normalize([{**raw, "explicit_route_fields": ["container", {"shopping_list_id": 999}]}], ctx)[0]
    assert malformed["explicit_route_fields"] == ["container", "section", "stores"]
    unresolved = router._normalize_braindump_json({"candidates": [{"module_id": "shopping", "title": "Milch", "shopping_list_name": "Nicht verfügbar", "explicit_route_fields": []}]}, "Milch auf Nicht verfügbar.", ctx)["candidates"][0]
    assert unresolved["shopping_list_id"] is None and unresolved["explicit_route_fields"] == ["container"]


def test_explicit_empty_routes_block_filling_but_inferred_destinations_can_learn():
    base = {"module_id": "shopping", "shopping_list_id": 2, "shopping_section_id": None, "shopping_store_ids": []}
    learned = {"module_id": "shopping", "shopping_list_id": 2, "shopping_section_id": 5, "shopping_store_ids": [3]}
    assert can_apply_learned_route({**base, "explicit_route_fields": ["container"]}, learned)
    assert not can_apply_learned_route({**base, "explicit_route_fields": ["section"]}, learned)
    assert not can_apply_learned_route({**base, "explicit_route_fields": ["stores"]}, learned)
    conflicting = {**learned, "shopping_list_id": 1, "shopping_section_id": 1, "shopping_store_ids": [1]}
    assert can_apply_learned_route({**base, "explicit_route_fields": []}, conflicting)
    assert not can_apply_learned_route(base, conflicting), "Absent provenance must not opt a resolved target into overrides"
    assert not can_apply_learned_route({**base, "explicit_route_fields": ["unknown"]}, conflicting)


def test_typed_deduplication_retains_explicit_route_protection():
    ctx = shopping_routing_context()
    ctx["supported_modules"] = ["tasks", "shopping"]
    shopping = {"module_id": "shopping", "title": "Milch", "shopping_list_id": 2, "explicit_route_fields": []}
    task = {"module_id": "tasks", "title": "Anrufen", "project_name": "Task project", "explicit_route_fields": []}
    ctx["projects"] = [{"id": 1, "name": "Task project", "sections": []}]
    result = normalize([
        shopping, {**shopping, "explicit_route_fields": ["container"]},
        task, {**task, "explicit_route_fields": ["container", "section"]},
    ], ctx)
    assert len(result) == 2, result
    assert result[0]["explicit_route_fields"] == ["container"]
    assert result[1]["explicit_route_fields"] == ["container", "section"]


def test_absent_or_invalid_provenance_preserves_supplied_empty_destinations():
    ctx = shopping_routing_context()
    ctx["supported_modules"] = ["tasks", "shopping"]
    ctx["projects"] = [{"id": 1, "name": "Task project", "sections": ["Calls"]}]
    shopping = {"module_id": "shopping", "title": "Milch", "shopping_list_id": 2, "shopping_section_id": None, "shopping_store_ids": []}
    task = {"module_id": "tasks", "title": "Anrufen", "project_name": "Task project", "section_name": None}
    targets = [
        {"module_id": "shopping", "shopping_list_id": 2, "shopping_section_id": 5, "shopping_store_ids": [3]},
        {"module_id": "tasks", "project_name": "Task project", "section_name": "Calls"},
    ]
    for metadata in ({}, {"explicit_route_fields": None}, {"explicit_route_fields": ["unknown"]}):
        result = normalize([{**shopping, **metadata}, {**task, **metadata}], ctx)
        assert result[0]["explicit_route_fields"] == ["container", "section", "stores"], result
        assert result[1]["explicit_route_fields"] == ["container", "section"], result
        assert all(not can_apply_learned_route(item, target) for item, target in zip(result, targets))
    inferred = normalize([{**shopping, "explicit_route_fields": []}, {**task, "explicit_route_fields": []}], ctx)
    assert all(can_apply_learned_route(item, target) for item, target in zip(inferred, targets))
    absent = normalize([{"module_id": "shopping", "title": "Milch"}], ctx)[0]
    assert absent["explicit_route_fields"] == [] and can_apply_learned_route(absent, targets[0])


def test_nonfinite_quantities_and_multilingual_names():
    with make_db() as db:
        result = normalize([
            {"module_id": "shopping", "title": title, "quantity_value": value}
            for title, value in [("牛奶", float("nan")), ("Молоко", float("inf")), ("米饭", -1), ("Яблоки", 0)]
        ], context(db))
        assert len(result) == 4, result
        assert [item["quantity_value"] for item in result] == [None, None, None, 0]
        json.dumps(result, allow_nan=False)


def test_units_are_canonical_before_review_and_deduplication():
    with make_db() as db:
        items = normalize([
            {"module_id": "shopping", "title": "Milk", "quantity_value": 2, "quantity_unit": unit}
            for unit in ("Liter", "литра", "l")
        ], context(db))
        assert len(items) == 1 and items[0]["quantity_unit"] == "l" and items[0]["quantity_value"] == 2, items
        unknown = normalize([{"module_id": "shopping", "title": "Tomatoes", "quantity_value": 0,
                              "quantity_unit": "My custom unit"}], context(db))[0]
        assert unknown["quantity_value"] == 0 and unknown["quantity_unit"] == "My custom unit", unknown


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
    legacy_prompt = build_effective_system_prompt({})
    assert legacy_prompt.splitlines()[0] == DEFAULT_BRAINDUMP_SYSTEM_PROMPT.splitlines()[0] == "You are BrainDump, a strict extractor for Nia."
    assert build_effective_system_prompt({}, supported_modules=["tasks", "shopping"]) == DEFAULT_BRAINDUMP_SYSTEM_PROMPT
    assert build_effective_system_prompt({"system_prompt_mode": "replace", "system_prompt_custom": "Custom only"}, supported_modules=["shopping"]) == "Custom only"
    appended = build_effective_system_prompt({"system_prompt_mode": "append", "system_prompt_custom": "My instruction"}, supported_modules=["tasks", "shopping"])
    assert "shopping_list_id" in appended and appended.endswith("My instruction")
    assert "Output each shopping item as a normal todo candidate" not in appended
    assert '"module_id":"tasks"' in appended and '"module_id":"shopping"' in appended
    assert "Output each shopping item as a normal todo candidate" in legacy_prompt
    assert "module_id" not in legacy_prompt
    assert "For every task candidate" in appended
    assert "compare each item's meaning against the sections of every shopping_lists entry" in appended
    assert "do not require literal word overlap" in appended
    assert '"shopping_list_id":10,"shopping_section_id":20' in appended
    assert "Both lists have equally fitting sections" in appended
    routing_rules = json.loads(router._format_workspace_context(shopping_routing_context()))["candidate_contract"]["rules"]
    assert any("A uniquely fitting section is evidence for its containing shopping list" in rule for rule in routing_rules)
    with make_db() as db:
        ctx = context(db)
        row = {"id": 1, "name": "X" * 200, "sections": [{"id": n, "name": "S" * 200} for n in range(16)], "stores": [{"id": n, "name": "M" * 120} for n in range(16)]}
        ctx["shopping_lists"] = [dict(row, id=n) for n in range(40)]
        formatted = router._format_workspace_context(ctx)
        assert len(formatted) <= 12000, len(formatted)
        payload = json.loads(formatted)
        assert payload["supported_modules"] == ["tasks", "shopping"] and payload["shopping_lists"]


def test_admin_prompt_preview_matches_the_transmitted_current_default():
    from routers import admin as admin_router

    app = FastAPI()
    app.include_router(admin_router.router)
    app.dependency_overrides[admin_router.require_admin] = lambda: True
    with make_db() as db:
        db.execute("CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT)")
        db.executemany("INSERT INTO app_config VALUES (?, ?)", [
            ("braindump_llm_model", "fixture-model"),
            ("braindump_llm_base_url", "https://llm.invalid"),
            ("braindump_llm_api_key", "fixture-secret"),
            ("braindump_system_prompt_custom", "Fixture admin instruction"),
        ])

        @contextmanager
        def db_context():
            yield db

        def llm_response(payload, headers, config):
            content = '{"candidates":[]}'
            return {"message": {"content": content}} if config["llm_provider"] == "ollama" else {"choices": [{"message": {"content": content}}]}

        with patch.object(config_service, "get_db", db_context), TestClient(app) as client:
            for mode in ("default", "append", "replace"):
                db.execute("INSERT OR REPLACE INTO app_config VALUES ('braindump_system_prompt_mode', ?)", (mode,))
                response = client.get("/api/admin/braindump-config")
                assert response.status_code == 200
                public = response.json()
                preview = public["default_system_prompt"]
                assert preview == DEFAULT_BRAINDUMP_SYSTEM_PROMPT and "shopping_section_id" in preview
                assert "llm_api_key" not in public and "fixture-secret" not in str(public)
                for provider in ("openai_compatible", "ollama"):
                    config = {**config_service.get_braindump_config(include_secrets=True), "llm_provider": provider}
                    with patch.object(router, "_post_llm_chat", side_effect=llm_response) as send:
                        router._extract_with_llm("Fixture transcript", 1, context(db), config)
                    actual = send.call_args.args[0]["messages"][0]["content"]
                    expected = (preview if mode == "default" else
                                f"{preview.rstrip()}\n\nAdditional admin instructions:\nFixture admin instruction" if mode == "append" else
                                "Fixture admin instruction")
                    assert actual == expected, (mode, provider)


def test_existing_task_learning_does_not_rewrite_shopping_candidates():
    shopping = {"module_id": "shopping", "title": "Milk", "shopping_list_id": 1, "shopping_section_id": 1, "shopping_store_ids": [1]}
    parsed = {"candidates": [shopping, {"module_id": "tasks", "title": "Call Alex", "project_name": None, "section_name": None}]}
    # The compatibility boundary delegates once to the common engine with its
    # declared Tasks-only capability; there is no second historical learner.
    with patch.object(router,"apply_module_routes",return_value=parsed) as shared, \
         patch.object(router,"_best_learned_route",side_effect=AssertionError("retired runtime learner called")):
        result = router._apply_learned_routes(None, 1, None, parsed)
    assert result["candidates"][0] == shopping
    assert shared.call_count == 1 and shared.call_args.args[4] == {"supported_modules":["tasks"]}


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
