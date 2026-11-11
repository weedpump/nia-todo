#!/usr/bin/env python3
"""Shared routing on disposable migrated SQLite + private in-process APIs only."""

from __future__ import annotations

import contextlib
import io
import json
import os
import sqlite3
import sys
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
TEST_ROOT = tempfile.TemporaryDirectory(prefix="nia-routing-memory-")
os.environ["NIA_TODO_DATA_DIR"] = TEST_ROOT.name
sys.path.insert(0, str(ROOT / "api"))

from fastapi import FastAPI
from fastapi.testclient import TestClient
import db as database
import migrate
from db import get_db
from routers import (
    braindump_v2 as brain,
    recipes,
    routing_memory as router,
    shopping,
    todos,
)
from routers.auth import require_auth
from services.braindump_routes import apply_module_routes
from services.entity_access import (
    register_personal_entity,
    grant_entity_access,
    remove_entity_access,
)
from services.routing_memory import (
    RoutingFeedback,
    normalize_item_name,
    record_route_choice,
    routing_state,
    task_workspace_id,
    suggest_module,
)
from services.routing_matcher import suggest_task_route, suggest_route


@contextlib.contextmanager
def fixture():
    with tempfile.TemporaryDirectory(dir=TEST_ROOT.name) as directory:
        path = Path(directory) / "routing.db"
        with patch.object(database, "DB_PATH", path), patch.object(
            migrate, "DB_PATH", path
        ), patch.object(
            shopping, "_broadcast_item_change", new=AsyncMock()
        ) as broadcasts, patch.object(
            recipes, "broadcast_sync_to_users", new=AsyncMock()
        ), patch.object(
            todos, "broadcast_todo_change", new=AsyncMock()
        ), patch.object(
            router, "broadcast_routing_settings", new=AsyncMock()
        ) as settings_broadcasts:
            with contextlib.redirect_stdout(io.StringIO()):
                migrate.run_migrations()
            with get_db() as db:
                users = [
                    db.execute(
                        "INSERT INTO users(username,braindump_enabled) VALUES (?,0)",
                        (f"routing-{n}",),
                    ).lastrowid
                    for n in range(3)
                ]
                lists, sections, stores = [], [], []
                for index, owner in enumerate((users[0], users[0], users[1])):
                    listing = db.execute(
                        "INSERT INTO shopping_lists(name,created_by_user_id) VALUES (?,?)",
                        (f"List {index}", owner),
                    ).lastrowid
                    register_personal_entity(db, "shopping_list", listing, owner)
                    lists.append(listing)
                    sections.append(
                        [
                            db.execute(
                                "INSERT INTO shopping_sections(shopping_list_id,name) VALUES (?,?)",
                                (listing, f"Shelf {n}"),
                            ).lastrowid
                            for n in range(2)
                        ]
                    )
                    stores.append(
                        [
                            db.execute(
                                "INSERT INTO shopping_stores(shopping_list_id,name) VALUES (?,?)",
                                (listing, f"Store {n}"),
                            ).lastrowid
                            for n in range(2)
                        ]
                    )
                grant_entity_access(db, "shopping_list", lists[0], users[0], users[2])
                book = db.execute(
                    "INSERT INTO cookbooks(name,created_by_user_id) VALUES ('Book',?)",
                    (users[0],),
                ).lastrowid
                register_personal_entity(db, "cookbook", book, users[0])
                workspaces = []
                for user in users:
                    workspaces.append(
                        db.execute(
                            "INSERT INTO workspaces(name,user_id,is_default) VALUES ('Personal',?,1)",
                            (user,),
                        ).lastrowid
                    )
                work = db.execute(
                    "INSERT INTO workspaces(name,user_id) VALUES ('Work',?)",
                    (users[0],),
                ).lastrowid
                projects = []
                task_sections = []
                for index, (owner, workspace) in enumerate(
                    (
                        (users[0], workspaces[0]),
                        (users[0], workspaces[0]),
                        (users[0], work),
                        (users[1], workspaces[1]),
                    )
                ):
                    project = db.execute(
                        "INSERT INTO projects(name,user_id,workspace_id,is_inbox) VALUES (?,?,?,?)",
                        (f"Project {index}", owner, workspace, int(index == 0)),
                    ).lastrowid
                    register_personal_entity(db, "project", project, owner)
                    projects.append(project)
                    task_sections.append(
                        [
                            db.execute(
                                "INSERT INTO sections(project_id,name) VALUES (?,?)",
                                (project, f"Section {n}"),
                            ).lastrowid
                            for n in range(2)
                        ]
                    )
            actor = {"id": users[0]}
            app = FastAPI()
            for api in (shopping, recipes, router, brain, todos):
                app.include_router(api.router)
            app.dependency_overrides[require_auth] = lambda: actor["id"]
            with TestClient(app, raise_server_exceptions=True) as client:

                def call(method, path, expected=200, **kwargs):
                    response = getattr(client, method)(path, **kwargs)
                    assert response.status_code == expected, (
                        method,
                        path,
                        response.status_code,
                        response.text,
                    )
                    return response.json()

                yield SimpleNamespace(
                    path=path,
                    users=users,
                    lists=lists,
                    sections=sections,
                    stores=stores,
                    book=book,
                    actor=actor,
                    client=client,
                    call=call,
                    broadcasts=broadcasts,
                    workspaces=workspaces,
                    work=work,
                    projects=projects,
                    task_sections=task_sections,
                    settings_broadcasts=settings_broadcasts,
                )


def feedback(fields, generation=0, event_id=None):
    return {
        "event_id": event_id or uuid.uuid4().hex,
        "generation": generation,
        "fields": fields,
    }


def create(
    f, name="Milk", *, listing=0, section=None, stores=None, routing=None, mutation=None
):
    body = {
        "name": name,
        "section_id": section,
        "store_ids": stores or [],
        "client_mutation_id": mutation or uuid.uuid4().hex,
    }
    if routing is not None:
        body["routing_feedback"] = routing
    return f.call("post", f"/api/shopping/lists/{f.lists[listing]}/items", json=body)


def state(f):
    return f.call("get", "/api/routing-memory")


def seed_token(
    db,
    user,
    token,
    module,
    target,
    *,
    workspace=None,
    section=None,
    stores=(),
    hits=100,
):
    now = datetime.now(timezone.utc).isoformat()
    project = target if module == "tasks" else None
    listing = target if module == "shopping" else None
    entry = db.execute(
        """INSERT INTO routing_memory_entries(user_id,module_id,key_kind,workspace_id,name_key,project_id,shopping_list_id,
        task_section_id,section_id,list_known,section_known,stores_known,store_ids_json,legacy_hits,updated_at)
        VALUES (?,?,'token',?,?,?,?,?,?,1,1,?,?,?,?)""",
        (
            user,
            module,
            workspace,
            token,
            project,
            listing,
            section if project else None,
            section if listing else None,
            int(bool(stores)),
            json.dumps(list(stores)),
            hits,
            now,
        ),
    ).lastrowid
    values = {"list": target, "module": module, "section": section}
    if stores:
        values["stores"] = list(stores)
    for field, value in values.items():
        db.execute(
            """INSERT INTO routing_memory_observations(user_id,entry_id,field,value_json,support_count,origin,observed_at)
            VALUES (?,?,?,?,?,'legacy',?)""",
            (user, entry, field, json.dumps(value), hits, now),
        )
    return entry


def test_generic_access_exact_names_fields_and_no_prediction_reinforcement():
    with fixture() as f:
        assert state(f) == {
            "enabled": True,
            "generation": 0,
            "revision": 0,
            "learned_routes": 0,
            "entries": [],
            "task_entries": [],
        }
        f.call("get", "/api/braindump/v2/learning", expected=403)
        for name in (
            "Öl",
            "盐",
            "米",
            "牛奶",
            "Μήλο",
            "ＡＰＰＬＥ",
            " Crème\u00a0 fraîche ",
        ):
            create(
                f,
                name,
                section=f.sections[0][0],
                stores=f.stores[0],
                routing=feedback(["list", "section", "stores"]),
            )
        entries = state(f)["entries"]
        assert {entry["name_key"] for entry in entries} == {
            normalize_item_name(name)
            for name in (
                "Öl",
                "盐",
                "米",
                "牛奶",
                "Μήλο",
                "ＡＰＰＬＥ",
                " Crème\u00a0 fraîche ",
            )
        }
        assert all(
            entry["store_ids"] == f.stores[0]
            and entry["stores_known"]
            and entry["section_known"]
            for entry in entries
        )
        assert "lita" != normalize_item_name("liter"), "no fuzzy spelling correction"
        predicted = create(f, "Apple", section=f.sections[0][1], routing=feedback([]))
        assert "routing_feedback" not in predicted and "event_id" not in str(predicted)
        apple = next(
            entry for entry in state(f)["entries"] if entry["name_key"] == "apple"
        )
        assert (
            apple["section_id"] == f.sections[0][0]
        ), "accepting a prediction must not teach an inferred target"
        create(f, "Milk", section=f.sections[0][0], routing=feedback(["list"]))
        milk = next(
            entry for entry in state(f)["entries"] if entry["name_key"] == "milk"
        )
        assert (
            milk["list_known"]
            and not milk["section_known"]
            and not milk["stores_known"]
        )
        create(
            f, "Milk", section=None, stores=[], routing=feedback(["section", "stores"])
        )
        milk = next(
            entry for entry in state(f)["entries"] if entry["name_key"] == "milk"
        )
        assert (
            milk["section_known"]
            and milk["section_id"] is None
            and milk["stores_known"]
            and milk["store_ids"] == []
        )


def test_field_history_list_confidence_and_patch_replay():
    with fixture() as f:
        item = create(
            f,
            routing=feedback(["list", "section", "stores"]),
            section=f.sections[0][0],
            stores=f.stores[0],
        )
        create(
            f,
            listing=1,
            section=f.sections[1][0],
            routing=feedback(["list", "section"]),
        )
        assert not any(
            row["preferred"] for row in state(f)["entries"]
        ), "one contradictory list choice is not a reliable preference"
        create(f, listing=1, routing=feedback(["list"]))
        create(f, section=f.sections[0][1], routing=feedback(["section"]))
        assert (
            state(f)["entries"][0]["shopping_list_id"] == f.lists[1]
        ), "section-only updates do not change preferred list"
        assert sum(entry["preferred"] for entry in state(f)["entries"]) == 1
        event = feedback(["section"])
        body = {"section_id": None, "routing_feedback": event}
        f.call("patch", f"/api/shopping/items/{item['id']}", json=body)
        with get_db() as db:
            receipt_count = db.execute(
                "SELECT COUNT(*) FROM routing_memory_events"
            ).fetchone()[0]
        f.call("patch", f"/api/shopping/items/{item['id']}", json=body)
        with get_db() as db:
            assert (
                db.execute("SELECT COUNT(*) FROM routing_memory_events").fetchone()[0]
                == receipt_count
            )
        f.call(
            "patch",
            f"/api/shopping/items/{item['id']}",
            json={"quantity_value": 2, "completed": True, "note": "Only metadata"},
        )
        with get_db() as db:
            assert (
                db.execute("SELECT COUNT(*) FROM routing_memory_events").fetchone()[0]
                == receipt_count
            )
        f.call(
            "patch",
            f"/api/shopping/items/{item['id']}",
            json={"section_id": f.sections[0][0]},
        )
        own = next(
            entry
            for entry in state(f)["entries"]
            if entry["shopping_list_id"] == f.lists[0]
        )
        assert (
            not own["section_known"] and own["store_ids"] == f.stores[0]
        ), "competing section history cannot overwrite independent stores"
        with get_db() as db:
            observed = db.execute(
                "SELECT COUNT(*) FROM routing_memory_observations"
            ).fetchone()[0]
        f.call(
            "patch",
            f"/api/shopping/items/{item['id']}",
            json={"section_id": f.sections[0][1], "routing_feedback": feedback([])},
        )
        with get_db() as db:
            assert (
                db.execute(
                    "SELECT COUNT(*) FROM routing_memory_observations"
                ).fetchone()[0]
                == observed
            )
            assert db.execute(
                "SELECT value_json FROM routing_memory_observations WHERE field='section' ORDER BY id DESC LIMIT 1"
            ).fetchone()[0] == str(f.sections[0][0])


def test_create_retry_generation_reset_opt_out_and_private_facade():
    with fixture() as f:
        event = feedback(["list", "section"])
        first = create(f, routing=event, mutation="stable", section=f.sections[0][0])
        assert (
            create(f, routing=event, mutation="stable", section=f.sections[0][0])["id"]
            == first["id"]
        )
        with get_db() as db:
            assert (
                db.execute("SELECT COUNT(*) FROM routing_memory_events").fetchone()[0]
                == 1
            )
        reset = f.call("delete", "/api/routing-memory")
        assert reset["generation"] == 1 and reset["entries"] == []
        f.settings_broadcasts.assert_awaited_with(f.users[0])
        create(f, "Delayed", routing=event, section=f.sections[0][1])
        assert (
            state(f)["entries"] == []
        ), "old offline generation must not recreate forgotten memory"
        create(f, "Fresh", routing=feedback(["list"], 1))
        disabled = f.call("patch", "/api/routing-memory", json={"enabled": False})
        assert (
            not disabled["enabled"]
            and disabled["generation"] == 2
            and disabled["entries"] == []
        )
        create(f, "Ignored", routing=feedback(["list"], 2))
        assert state(f)["entries"] == []
        assert (
            f.call("patch", "/api/routing-memory", json={"enabled": True})["generation"]
            == 3
        )
        create(f, "Fresh", routing=feedback(["list"], 3))
        with patch.object(brain, "require_braindump_access"):
            assert f.call("get", "/api/braindump/v2/learning")["learned_routes"] > 0
            assert f.call("delete", "/api/braindump/v2/learning")["generation"] == 4
        assert state(f)["entries"] == []


def test_scoped_children_account_privacy_revocation_and_deletions():
    with fixture() as f:
        create(
            f,
            "Shared",
            section=f.sections[0][0],
            stores=f.stores[0],
            routing=feedback(["list", "section", "stores"]),
        )
        f.actor["id"] = f.users[2]
        assert (
            state(f)["entries"] == []
        ), "sharing content never shares personal route memory"
        create(
            f,
            "Own memory",
            section=f.sections[0][0],
            stores=f.stores[0],
            routing=feedback(["list", "section", "stores"]),
        )
        with get_db() as db:
            remove_entity_access(
                db, "shopping_list", f.lists[0], f.users[0], f.users[2]
            )
        assert state(f)["entries"] == []
        with get_db() as db:
            grant_entity_access(db, "shopping_list", f.lists[0], f.users[0], f.users[2])
        assert len(state(f)["entries"]) == 1
        with get_db() as db:
            db.execute(
                "UPDATE shopping_stores SET active = 0 WHERE id = ?", (f.stores[0][0],)
            )
        entry = state(f)["entries"][0]
        assert (
            not entry["stores_known"]
            and entry["store_ids"] == []
            and entry["section_known"]
        )
        with get_db() as db:
            db.execute(
                "DELETE FROM shopping_sections WHERE id = ?", (f.sections[0][0],)
            )
        entry = state(f)["entries"][0]
        assert (
            not entry["section_known"]
            and entry["section_id"] is None
            and entry["list_known"]
        )
        f.actor["id"] = f.users[0]
        f.call(
            "post",
            f"/api/shopping/lists/{f.lists[0]}/items",
            expected=400,
            json={
                "name": "Wrong scoped target",
                "section_id": f.sections[1][0],
                "routing_feedback": feedback(["section"]),
            },
        )
        with get_db() as db:
            db.execute("DELETE FROM shopping_lists WHERE id = ?", (f.lists[0],))
        assert state(f)["entries"] == []


def test_recipe_cross_flow_unique_events_full_sources_and_immutable_replay():
    with fixture() as f:
        source = f.call(
            "post",
            f"/api/recipes/cookbooks/{f.book}/recipes",
            json={
                "client_mutation_id": "recipe",
                "title": "Meal",
                "base_servings": 2,
                "ingredient_groups": [
                    {
                        "client_key": "g",
                        "name": "Ingredients",
                        "ingredients": [
                            {
                                "client_key": "a",
                                "name": "Mehl",
                                "quantity_value": 100,
                                "quantity_unit": "g",
                            },
                            {
                                "client_key": "b",
                                "name": "Mehl",
                                "quantity_value": 50,
                                "quantity_unit": "g",
                            },
                        ],
                    }
                ],
                "steps": [],
            },
        )
        data = {
            "shopping_list_id": f.lists[0],
            "servings": 2,
            "expected_revision": source["revision"],
            "client_mutation_id": "transfer",
            "ingredients": [
                {
                    "ingredient_client_key": key,
                    "section_id": f.sections[0][0],
                    "store_ids": f.stores[0],
                    "routing_feedback": feedback(["list", "section", "stores"]),
                }
                for key in ("a", "b")
            ],
        }
        route = f"/api/recipes/recipes/{source['id']}/shopping-transfer"
        first = f.call("post", route, json=data)
        assert f.call("post", route, json=data) == first
        with get_db() as db:
            assert (
                db.execute("SELECT COUNT(*) FROM routing_memory_events").fetchone()[0]
                == 1
            ), "same product and choice learns once per recipe operation"
            assert (
                db.execute(
                    "SELECT COUNT(*) FROM shopping_item_recipe_sources"
                ).fetchone()[0]
                == 2
            )
            ctx = brain._load_braindump_extraction_context(
                db, f.users[0], None, ["shopping"]
            )
            candidate = {
                "module_id": "shopping",
                "title": "Mehl",
                "shopping_list_id": None,
                "shopping_store_ids": [],
                "explicit_route_fields": [],
            }
            result = apply_module_routes(
                db, f.users[0], None, {"candidates": [candidate]}, ctx
            )["candidates"][0]
            assert (
                result["shopping_list_id"] == f.lists[0]
                and result["shopping_store_ids"] == f.stores[0]
            )
            explicit = {
                **candidate,
                "shopping_list_id": f.lists[1],
                "explicit_route_fields": ["container"],
            }
            assert (
                apply_module_routes(
                    db, f.users[0], None, {"candidates": [explicit]}, ctx
                )["candidates"][0]
                == explicit
            )
        assert state(f)["entries"][0]["name_key"] == "mehl"
        f.call("delete", "/api/routing-memory")
        assert f.call("post", route, json=data) == first
        assert (
            state(f)["entries"] == []
        ), "receipt replay after reset cannot train again"
        data["ingredients"][0]["routing_feedback"]["generation"] = 1
        f.call("post", route, expected=409, json=data)


def test_recipe_conflicting_destinations_do_not_choose_memory_by_source_order():
    with fixture() as f:
        cases = [
            (
                "Mehl",
                [f.sections[0][0], f.sections[0][1]],
                [f.stores[0], list(reversed(f.stores[0]))],
                ["list", "section", "stores"],
                False,
                True,
            ),
            (
                "Öl",
                [f.sections[0][0], f.sections[0][0]],
                [[f.stores[0][0]], [f.stores[0][1]]],
                ["list", "section", "stores"],
                True,
                False,
            ),
            (
                "米",
                [None, f.sections[0][1]],
                [[], [f.stores[0][1]]],
                ["section", "stores"],
                False,
                False,
            ),
        ]
        for index, (
            name,
            sections,
            stores,
            chosen_fields,
            section_known,
            stores_known,
        ) in enumerate(cases):
            source = f.call(
                "post",
                f"/api/recipes/cookbooks/{f.book}/recipes",
                json={
                    "client_mutation_id": f"conflicting-source-{index}",
                    "title": "Meal",
                    "base_servings": 2,
                    "ingredient_groups": [
                        {
                            "client_key": "g",
                            "name": "Ingredients",
                            "ingredients": [
                                {
                                    "client_key": key,
                                    "name": name,
                                    "quantity_value": 1,
                                    "quantity_unit": "g",
                                }
                                for key in ("a", "b")
                            ],
                        }
                    ],
                    "steps": [],
                },
            )
            data = {
                "shopping_list_id": f.lists[0],
                "servings": 2,
                "expected_revision": source["revision"],
                "client_mutation_id": f"conflicting-transfer-{index}",
                "ingredients": [
                    {
                        "ingredient_client_key": key,
                        "section_id": sections[n],
                        "store_ids": stores[n],
                        "routing_feedback": feedback(chosen_fields),
                    }
                    for n, key in enumerate(("a", "b"))
                ],
            }
            route = f"/api/recipes/recipes/{source['id']}/shopping-transfer"
            first = f.call("post", route, json=data)
            assert f.call("post", route, json=data) == first
            entry = next(
                (
                    row
                    for row in state(f)["entries"]
                    if row["name_key"] == normalize_item_name(name)
                ),
                None,
            )
            if chosen_fields == ["section", "stores"]:
                assert (
                    entry is None
                ), "entirely conflicting fields must not invent a remembered choice"
            else:
                assert (
                    entry["list_known"]
                    and entry["section_known"] is section_known
                    and entry["stores_known"] is stores_known
                )
                if section_known:
                    assert entry["section_id"] == sections[0]
                if stores_known:
                    assert entry["store_ids"] == stores[0]
            items = [
                item for item in first["shopping_list"]["items"] if item["name"] == name
            ]
            assert (
                len(items) == 2
            ), "learning suppression must not alter the separate content destinations"
            assert sorted(
                [(item["section_id"], tuple(item["store_ids"])) for item in items],
                key=repr,
            ) == sorted(
                [(sections[n], tuple(sorted(set(stores[n])))) for n in range(2)],
                key=repr,
            )
            assert sum(item["recipe_sources_count"] for item in items) == 2
        with get_db() as db:
            assert (
                db.execute("SELECT COUNT(*) FROM routing_memory_events").fetchone()[0]
                == 2
            ), "agreed fields learn once per product/operation"


def test_migration_upgrade_preserves_old_routes_opt_out_and_is_atomic():
    with tempfile.TemporaryDirectory(dir=TEST_ROOT.name) as directory:
        path = Path(directory) / "upgrade.db"
        with patch.object(database, "DB_PATH", path), patch.object(
            migrate, "DB_PATH", path
        ):
            files = migrate.get_migration_files()
            with patch.object(
                migrate,
                "get_migration_files",
                return_value=[entry for entry in files if entry[0] <= 66],
            ), contextlib.redirect_stdout(io.StringIO()):
                migrate.run_migrations()
            with get_db() as db:
                user = db.execute(
                    "INSERT INTO users(username,braindump_learning_enabled) VALUES ('opt-out',0)"
                ).lastrowid
                project = db.execute(
                    "INSERT INTO projects(name,user_id) VALUES ('Old',?)", (user,)
                ).lastrowid
                db.execute(
                    "INSERT INTO braindump_route_learning(user_id,token,project_id,hits,last_used_at) VALUES (?,'milk',?,7,'before')",
                    (user, project),
                )
                before = tuple(
                    db.execute("SELECT * FROM braindump_route_learning").fetchone()
                )
                sql = (
                    ROOT / "api/migrations/067_add_shared_routing_memory.sql"
                ).read_text()
                try:
                    migrate.apply_atomic_migration(
                        db, sql + "\nSELECT * FROM forced_routing_failure;", 67
                    )
                except sqlite3.OperationalError as error:
                    assert "forced_routing_failure" in str(error)
                else:
                    raise AssertionError(
                        "Fault-injected migration unexpectedly succeeded"
                    )
                assert "routing_memory_generation" not in {
                    row[1] for row in db.execute("PRAGMA table_info(users)")
                }
                assert (
                    tuple(
                        db.execute("SELECT * FROM braindump_route_learning").fetchone()
                    )
                    == before
                )
            with contextlib.redirect_stdout(io.StringIO()):
                migrate.run_migrations()
            with get_db() as db:
                assert (
                    db.execute("SELECT version FROM schema_version").fetchone()[0]
                    == max(version for version, _ in files)
                )
                imported = db.execute(
                    "SELECT * FROM routing_memory_entries WHERE key_kind='token'"
                ).fetchone()
                assert (
                    imported["legacy_hits"] == before[6]
                    and imported["name_key"] == "milk"
                )
                assert (
                    routing_state(db, user)["enabled"] is False
                    and routing_state(db, user)["generation"] == 0
                )
                assert db.execute("PRAGMA foreign_key_check").fetchall() == []


def test_memory_failure_rolls_back_content_and_receipts():
    with fixture() as f:
        with patch.object(
            shopping,
            "record_route_choice",
            side_effect=RuntimeError("forced memory failure"),
        ):
            try:
                create(f, routing=feedback(["list"]))
            except RuntimeError as error:
                assert "forced memory failure" in str(error)
            else:
                raise AssertionError("Write failure was swallowed")
        with get_db() as db:
            assert db.execute("SELECT COUNT(*) FROM shopping_items").fetchone()[0] == 0
            assert (
                db.execute("SELECT COUNT(*) FROM routing_memory_events").fetchone()[0]
                == 0
            )


def test_confidence_competition_repeated_corrections_bounded_history_and_counterfactual_predictions():
    with fixture() as f:
        for _ in range(10):
            create(
                f,
                "Tomaten",
                section=f.sections[0][0],
                stores=[f.stores[0][0]],
                routing=feedback(["list", "section", "stores"]),
            )
        stable = state(f)["entries"][0]
        assert (
            stable["section_known"] and stable["evidence"]["section"]["support"] == 10
        )
        create(f, "Tomaten", section=f.sections[0][1], routing=feedback(["section"]))
        uncertain = state(f)["entries"][0]
        assert not uncertain["section_known"] and uncertain["section_id"] is None
        assert (
            uncertain["evidence"]["section"]["conflicts"]
            and "section" in uncertain["history_fields"]
        )
        assert (
            uncertain["list_known"]
            and uncertain["stores_known"]
            and uncertain["store_ids"] == [f.stores[0][0]]
        )
        with get_db() as db:
            assert (
                db.execute(
                    "SELECT weight FROM routing_memory_observations WHERE field='section' ORDER BY id DESC LIMIT 1"
                ).fetchone()[0]
                == 3
            )
            before = db.execute(
                "SELECT COUNT(*) FROM routing_memory_observations"
            ).fetchone()[0]
        for _ in range(10):
            create(f, "Tomaten", section=f.sections[0][1], routing=feedback([]))
        with get_db() as db:
            assert (
                db.execute(
                    "SELECT COUNT(*) FROM routing_memory_observations"
                ).fetchone()[0]
                == before
            ), "accepting automatic proposals is not supporting evidence"
        assert not state(f)["entries"][0]["section_known"]
        for _ in range(7):
            create(
                f, "Tomaten", section=f.sections[0][1], routing=feedback(["section"])
            )
        adapted = state(f)["entries"][0]
        assert adapted["section_known"] and adapted["section_id"] == f.sections[0][1]
        assert (
            adapted["evidence"]["section"]["support"] == 8
            and adapted["evidence"]["section"]["reliable"]
        )
        for _ in range(25):
            create(
                f, "Tomaten", section=f.sections[0][1], routing=feedback(["section"])
            )
        with get_db() as db:
            assert (
                db.execute(
                    "SELECT COUNT(*) FROM routing_memory_observations WHERE field='section'"
                ).fetchone()[0]
                == 20
            )
        assert not state(f)["entries"][0]["evidence"]["section"][
            "conflicts"
        ], "old disagreements leave the bounded history"


def test_explicit_none_and_empty_store_choices_need_repeated_support_after_conflict():
    with fixture() as f:
        create(
            f,
            "Öl",
            section=f.sections[0][0],
            stores=[f.stores[0][0]],
            routing=feedback(["list", "section", "stores"]),
        )
        create(
            f, "Öl", section=None, stores=[], routing=feedback(["section", "stores"])
        )
        entry = state(f)["entries"][0]
        assert (
            not entry["section_known"]
            and not entry["stores_known"]
            and entry["list_known"]
        )
        create(
            f, "Öl", section=None, stores=[], routing=feedback(["section", "stores"])
        )
        entry = state(f)["entries"][0]
        assert entry["section_known"] and entry["section_id"] is None
        assert entry["stores_known"] and entry["store_ids"] == []
        assert (
            entry["evidence"]["section"]["support"] == 2
            and entry["evidence"]["stores"]["support"] == 2
        )


def test_age_recency_and_global_list_confidence_keep_fixed_list_children():
    with fixture() as f:
        for _ in range(10):
            create(
                f,
                "Milk",
                section=f.sections[0][0],
                routing=feedback(["list", "section"]),
            )
        ancient = (datetime.now(timezone.utc) - timedelta(days=730)).isoformat()
        with get_db() as db:
            db.execute(
                "UPDATE routing_memory_observations SET observed_at = ?", (ancient,)
            )
        assert not state(f)["entries"][0][
            "section_known"
        ], "sufficiently old evidence is not a current reliable choice"
        create(f, "Milk", section=f.sections[0][1], routing=feedback(["section"]))
        assert not state(f)["entries"][0][
            "section_known"
        ], "a conflicting single observation remains weak even against old evidence"
        create(f, "Milk", section=f.sections[0][1], routing=feedback(["section"]))
        assert state(f)["entries"][0]["section_id"] == f.sections[0][1]
        # Independent current list histories compete across entries, while an
        # explicitly selected list retains its own reliable section memory.
        for _ in range(10):
            create(
                f, "米", section=f.sections[0][0], routing=feedback(["list", "section"])
            )
        create(
            f,
            "米",
            listing=1,
            section=f.sections[1][0],
            routing=feedback(["list", "section"]),
        )
        entries = [entry for entry in state(f)["entries"] if entry["name_key"] == "米"]
        assert not any(entry["preferred"] or entry["list_known"] for entry in entries)
        fixed = next(
            entry for entry in entries if entry["shopping_list_id"] == f.lists[1]
        )
        assert fixed["section_known"] and fixed["section_id"] == f.sections[1][0]
        for _ in range(7):
            create(f, "米", listing=1, routing=feedback(["list"]))
        entries = [entry for entry in state(f)["entries"] if entry["name_key"] == "米"]
        assert (
            next(entry for entry in entries if entry["preferred"])["shopping_list_id"]
            == f.lists[1]
        )


def test_observation_reset_and_event_replay_do_not_reconstruct_history():
    with fixture() as f:
        deliberate = feedback(["list", "section"])
        item = create(
            f, "Salt", section=None, routing=deliberate, mutation="history-stable"
        )
        create(f, "Salt", section=None, routing=deliberate, mutation="history-stable")
        with get_db() as db:
            assert (
                db.execute(
                    "SELECT COUNT(*) FROM routing_memory_observations"
                ).fetchone()[0]
                == 3
            )
        f.call("delete", "/api/routing-memory")
        create(f, "Salt", section=None, routing=deliberate, mutation="history-stable")
        f.call(
            "patch",
            f"/api/shopping/items/{item['id']}",
            json={"section_id": f.sections[0][0], "routing_feedback": deliberate},
        )
        with get_db() as db:
            assert (
                db.execute(
                    "SELECT COUNT(*) FROM routing_memory_observations"
                ).fetchone()[0]
                == 0
            )


def test_braindump_personal_phrase_marks_only_applied_fields_and_blocks_weak_import_fallback():
    with fixture() as f:
        create(
            f,
            "Äpfel",
            section=f.sections[0][0],
            stores=[f.stores[0][0]],
            routing=feedback(["list", "section", "stores"]),
        )
        with get_db() as db:
            context = brain._load_braindump_extraction_context(
                db, f.users[0], None, ["shopping"]
            )
            candidate = {
                "module_id": "shopping",
                "title": "frische Äpfel",
                "shopping_list_id": None,
                "shopping_section_id": None,
                "shopping_store_ids": [],
                "explicit_route_fields": [],
            }
            apply = lambda item: apply_module_routes(
                db, f.users[0], None, {"candidates": [item]}, context
            )["candidates"][0]
            matched = apply(candidate)
            assert (
                matched["shopping_list_id"] == f.lists[0]
                and matched["shopping_section_id"] == f.sections[0][0]
            )
            assert matched["memory_route_fields"] == ["list", "section", "stores"]
            spoken_section = {
                **candidate,
                "shopping_list_id": f.lists[0],
                "explicit_route_fields": ["container", "section"],
            }
            preserved = apply(spoken_section)
            assert preserved["shopping_section_id"] is None and preserved[
                "shopping_store_ids"
            ] == [f.stores[0][0]]
            assert preserved["memory_route_fields"] == [
                "stores"
            ], "spoken empty section and fixed list must not be marked as memory"
            spoken_stores = {
                **candidate,
                "shopping_list_id": f.lists[0],
                "explicit_route_fields": ["container", "stores"],
            }
            preserved = apply(spoken_stores)
            assert (
                preserved["shopping_store_ids"] == []
                and preserved["shopping_section_id"] == f.sections[0][0]
            )
            assert preserved["memory_route_fields"] == ["section"]
        create(f, "Tomaten", routing=feedback(["list"]))
        create(f, "Tomaten", listing=1, routing=feedback(["list"]))
        with get_db() as db:
            seed_token(db, f.users[0], "tomaten", "shopping", f.lists[1], hits=99)
            context = brain._load_braindump_extraction_context(
                db, f.users[0], None, ["shopping"]
            )
            ambiguous = {
                "module_id": "shopping",
                "title": "Tomaten",
                "shopping_list_id": None,
                "shopping_section_id": None,
                "shopping_store_ids": [],
                "explicit_route_fields": [],
            }
            result = apply_module_routes(
                db, f.users[0], None, {"candidates": [ambiguous]}, context
            )["candidates"][0]
            assert (
                result["shopping_list_id"] is None
                and result.get("memory_route_fields", []) == []
            ), "old token routes must not override ambiguous personal full-name history"


def test_migration_068_backfills_one_observation_without_fabricated_support():
    with tempfile.TemporaryDirectory(dir=TEST_ROOT.name) as directory:
        path = Path(directory) / "history-upgrade.db"
        with patch.object(database, "DB_PATH", path), patch.object(
            migrate, "DB_PATH", path
        ):
            files = migrate.get_migration_files()
            with patch.object(
                migrate,
                "get_migration_files",
                return_value=[entry for entry in files if entry[0] <= 67],
            ), contextlib.redirect_stdout(io.StringIO()):
                migrate.run_migrations()
            with get_db() as db:
                user = db.execute(
                    "INSERT INTO users(username) VALUES ('history-user')"
                ).lastrowid
                listing = db.execute(
                    "INSERT INTO shopping_lists(name,created_by_user_id) VALUES ('List',?)",
                    (user,),
                ).lastrowid
                register_personal_entity(db, "shopping_list", listing, user)
                now = datetime.now(timezone.utc).isoformat()
                db.execute(
                    """INSERT INTO routing_memory_entries(user_id,name_key,shopping_list_id,list_known,section_known,
                    stores_known,store_ids_json,updated_at) VALUES (?,'öl',?,1,1,1,'[]',?)""",
                    (user, listing, now),
                )
                before = tuple(
                    db.execute("SELECT * FROM routing_memory_entries").fetchone()
                )
                sql = (
                    ROOT / "api/migrations/068_add_routing_memory_observations.sql"
                ).read_text()
                try:
                    migrate.apply_atomic_migration(
                        db, sql + "\nSELECT * FROM forced_history_failure;", 68
                    )
                except sqlite3.OperationalError as error:
                    assert "forced_history_failure" in str(error)
                else:
                    raise AssertionError(
                        "Fault-injected history migration unexpectedly succeeded"
                    )
                assert not db.execute(
                    "SELECT 1 FROM sqlite_master WHERE name='routing_memory_observations'"
                ).fetchone()
                assert (
                    tuple(db.execute("SELECT * FROM routing_memory_entries").fetchone())
                    == before
                )
            with contextlib.redirect_stdout(io.StringIO()):
                migrate.run_migrations()
            with get_db() as db:
                observations = db.execute(
                    "SELECT field,weight,event_id FROM routing_memory_observations"
                ).fetchall()
                assert len(observations) == 4 and {
                    tuple(row) for row in observations
                } == {
                    (field, 1, None)
                    for field in ("module", "list", "section", "stores")
                }
                assert (
                    db.execute(
                        "SELECT name_key FROM routing_memory_entries"
                    ).fetchone()[0]
                    == before[2]
                )
                entry = routing_state(db, user)["entries"][0]
                assert all(
                    entry["evidence"][field]["support"] == 1
                    for field in ("list", "section", "stores")
                )
                assert (
                    entry["section_known"]
                    and entry["section_id"] is None
                    and entry["stores_known"]
                    and entry["store_ids"] == []
                )


def test_normal_tasks_atomic_learning_ids_retry_and_no_prediction_reinforcement():
    with fixture() as f:
        body = {
            "title": "Wäsche waschen",
            "project_id": f.projects[1],
            "section_id": f.task_sections[1][0],
            "_tempId": "task-stable",
            "routing_feedback": feedback(["list", "section"]),
        }
        first = f.call("post", "/api/todos", json=body)
        assert f.call("post", "/api/todos", json=body)["id"] == first["id"]
        entries = state(f)["task_entries"]
        route = suggest_task_route(entries, "Wäsche waschen", f.workspaces[0])
        assert (
            route["project_id"] == f.projects[1]
            and route["section_id"] == f.task_sections[1][0]
        )
        with get_db() as db:
            assert db.execute("SELECT COUNT(*) FROM todos").fetchone()[0] == 1
            before = db.execute(
                "SELECT COUNT(*) FROM routing_memory_observations"
            ).fetchone()[0]
        f.call(
            "patch",
            f"/api/todos/{first['id']}",
            json={"priority": 2, "routing_feedback": feedback([])},
        )
        f.call(
            "patch",
            f"/api/todos/{first['id']}",
            json={
                "section_id": f.task_sections[1][1],
                "routing_feedback": feedback(["section"]),
            },
        )
        with get_db() as db:
            assert (
                db.execute(
                    "SELECT COUNT(*) FROM routing_memory_observations"
                ).fetchone()[0]
                == before + 1
            )
        assert not state(f)["task_entries"][0][
            "section_known"
        ], "a single contradictory correction stays uncertain"
        original = feedback(["section"])
        f.call("delete", "/api/routing-memory")
        f.call(
            "patch",
            f"/api/todos/{first['id']}",
            json={"section_id": None, "routing_feedback": original},
        )
        assert (
            state(f)["task_entries"] == []
        ), "old offline feedback cannot reconstruct reset memory"


def test_token_100_hit_correction_retires_only_affected_legacy_fields_and_scope():
    with fixture() as f:
        with get_db() as db:
            for token in ("wäsche", "waschen"):
                seed_token(
                    db,
                    f.users[0],
                    token,
                    "tasks",
                    f.projects[0],
                    workspace=None,
                    section=f.task_sections[0][0],
                )
            untouched = seed_token(
                db,
                f.users[0],
                "waschen",
                "tasks",
                f.projects[2],
                workspace=f.work,
                section=f.task_sections[2][0],
            )
        old = suggest_task_route(
            state(f)["task_entries"], "Wäsche waschen", f.workspaces[0]
        )
        assert old["project_id"] == f.projects[0] and old["match_kind"] == "phrase"
        f.call(
            "post",
            "/api/todos",
            json={
                "title": "Wäsche waschen",
                "project_id": f.projects[1],
                "section_id": f.task_sections[1][1],
                "client_mutation_id": "correct-import",
                "routing_feedback": feedback(["list", "section"]),
            },
        )
        corrected = suggest_task_route(
            state(f)["task_entries"], "Wäsche waschen morgen", f.workspaces[0]
        )
        assert (
            corrected["project_id"] == f.projects[1]
        ), "a correction must update token memory for another full title too"
        with get_db() as db:
            legacy = db.execute(
                "SELECT SUM(legacy_hits) FROM routing_memory_entries WHERE module_id='tasks' AND name_key IN ('wäsche','waschen')"
            ).fetchone()[0]
            assert legacy == 300, "original counter metadata remains truthful"
            assert (
                db.execute(
                    "SELECT COUNT(*) FROM routing_memory_observations WHERE entry_id=? AND origin='legacy' AND field='list'",
                    (untouched,),
                ).fetchone()[0]
                == 1
            )
            assert (
                db.execute(
                    "SELECT COUNT(*) FROM routing_memory_observations observation JOIN routing_memory_entries entry ON entry.id=observation.entry_id WHERE entry.project_id=? AND observation.field='list' AND origin='legacy'",
                    (f.projects[0],),
                ).fetchone()[0]
                == 0
            )
        assert (
            suggest_task_route(state(f)["task_entries"], "Auto waschen", f.work)[
                "project_id"
            ]
            == f.projects[2]
        )


def test_null_workspace_token_section_correction_coalesces_projection_without_duplicate_votes():
    with fixture() as f:
        with get_db() as db:
            for token in ("wäsche", "waschen"):
                seed_token(
                    db,
                    f.users[0],
                    token,
                    "tasks",
                    f.projects[0],
                    workspace=None,
                    section=f.task_sections[0][0],
                )
        f.call(
            "post",
            "/api/todos",
            json={
                "title": "Wäsche waschen",
                "project_id": f.projects[0],
                "section_id": f.task_sections[0][1],
                "routing_feedback": feedback(["section"]),
            },
        )
        entries = state(f)["task_entries"]
        tokens = [entry for entry in entries if entry["key_kind"] == "token"]
        assert (
            len(tokens) == 2
        ), "NULL and current workspace identities project once per logical token target"
        route = suggest_task_route(entries, "Wäsche waschen morgen", f.workspaces[0])
        assert route["section_id"] == f.task_sections[0][1]
        assert all(
            entry["evidence"]["list"]["target_support"] == 100 for entry in tokens
        ), "project votes are not doubled by mapped NULL identities"


def test_task_ids_override_ambiguous_names_and_shared_workspace_mapping_is_actor_local():
    with fixture() as f:
        with get_db() as db:
            db.execute(
                "UPDATE projects SET name='Same' WHERE id IN (?,?)",
                tuple(f.projects[:2]),
            )
        with patch.object(brain, "require_braindump_access"):
            result = f.call(
                "post",
                "/api/braindump/v2/todos",
                json={
                    "workspace_id": f.workspaces[0],
                    "candidates": [
                        {
                            "title": "IDs win",
                            "project_id": f.projects[1],
                            "project_name": "Same",
                            "section_id": f.task_sections[1][1],
                            "routing_feedback": feedback(["list", "section"]),
                            "client_mutation_id": "bd-ids",
                        }
                    ],
                },
            )
        with get_db() as db:
            saved = db.execute(
                "SELECT project_id,section_id FROM todos WHERE title='IDs win'"
            ).fetchone()
            assert tuple(saved) == (f.projects[1], f.task_sections[1][1])
            grant_entity_access(db, "project", f.projects[0], f.users[0], f.users[2])
        f.actor["id"] = f.users[2]
        f.call(
            "post",
            "/api/todos",
            json={
                "title": "Shared scope",
                "project_id": f.projects[0],
                "routing_feedback": feedback(["list"]),
            },
        )
        assert state(f)["task_entries"][0]["workspace_id"] == f.workspaces[2]
        f.actor["id"] = f.users[0]
        assert all(
            row["name_key"] != "shared scope" for row in state(f)["task_entries"]
        )


def test_module_only_corrections_do_not_learn_an_implicit_container_or_drop_typed_content():
    with fixture() as f:
        with get_db() as db:
            for token in ("wäsche", "waschen"):
                seed_token(
                    db,
                    f.users[0],
                    token,
                    "tasks",
                    f.projects[0],
                    workspace=f.workspaces[0],
                )
        create(f, "Wäsche waschen", routing=feedback(["module"]))
        entry = state(f)["entries"][0]
        assert not entry["list_known"] and "list" not in entry["history_fields"]
        with get_db() as db:
            context = brain._load_braindump_extraction_context(
                db, f.users[0], f.workspaces[0], ["tasks", "shopping"]
            )
            candidate = {
                "module_id": "tasks",
                "title": "Wäsche waschen",
                "project_name": None,
                "section_name": None,
                "explicit_route_fields": [],
            }
            routed = brain._apply_learned_routes(
                db, f.users[0], f.workspaces[0], {"candidates": [candidate]}, context
            )["candidates"][0]
            assert (
                routed["module_id"] == "shopping"
                and routed["shopping_list_id"] is None
                and routed["memory_route_fields"] == ["module"]
            )
            scheduled = {**candidate, "deadline": "2026-12-01T12:00:00+00:00"}
            kept = brain._apply_learned_routes(
                db, f.users[0], f.workspaces[0], {"candidates": [scheduled]}, context
            )["candidates"][0]
            assert (
                kept["module_id"] == "tasks"
                and kept["deadline"] == scheduled["deadline"]
            )
            noted = {**candidate, "notes": "Do not lose this note"}
            kept = brain._apply_learned_routes(
                db, f.users[0], f.workspaces[0], {"candidates": [noted]}, context
            )["candidates"][0]
            assert kept["module_id"] == "tasks" and kept["notes"] == noted["notes"]


def test_real_069_upgrade_imports_all_sources_without_dual_counting_and_rolls_back_atomically():
    with tempfile.TemporaryDirectory(dir=TEST_ROOT.name) as directory:
        path = Path(directory) / "upgrade069.db"
        with patch.object(database, "DB_PATH", path), patch.object(
            migrate, "DB_PATH", path
        ):
            migrations = migrate.get_migration_files()
            with patch.object(
                migrate,
                "get_migration_files",
                return_value=[row for row in migrations if row[0] <= 68],
            ), contextlib.redirect_stdout(io.StringIO()):
                migrate.run_migrations()
            with get_db() as db:
                user = db.execute(
                    "INSERT INTO users(username) VALUES ('import-owner')"
                ).lastrowid
                disabled = db.execute(
                    "INSERT INTO users(username,braindump_learning_enabled) VALUES ('disabled',0)"
                ).lastrowid
                workspace = db.execute(
                    "INSERT INTO workspaces(name,user_id,is_default) VALUES ('Personal',?,1)",
                    (user,),
                ).lastrowid
                projects = []
                sections = []
                for name in ("A", "B"):
                    project = db.execute(
                        "INSERT INTO projects(name,user_id,workspace_id) VALUES (?,?,?)",
                        (name, user, workspace),
                    ).lastrowid
                    register_personal_entity(db, "project", project, user)
                    projects.append(project)
                    sections.append(
                        db.execute(
                            "INSERT INTO sections(name,project_id) VALUES ('Wash',?)",
                            (project,),
                        ).lastrowid
                    )
                listing = db.execute(
                    "INSERT INTO shopping_lists(name,created_by_user_id) VALUES ('Groceries',?)",
                    (user,),
                ).lastrowid
                register_personal_entity(db, "shopping_list", listing, user)
                shelf = db.execute(
                    "INSERT INTO shopping_sections(name,shopping_list_id) VALUES ('Shelf',?)",
                    (listing,),
                ).lastrowid
                stamp = datetime.now(timezone.utc).isoformat()
                for target, hits in ((0, 100), (1, 7)):
                    db.execute(
                        "INSERT INTO braindump_route_learning(user_id,workspace_id,token,project_id,section_id,hits,last_used_at) VALUES (?,?,'waschen',?,?,?,?)",
                        (
                            user,
                            workspace,
                            projects[target],
                            sections[target],
                            hits,
                            stamp,
                        ),
                    )
                    db.execute(
                        "INSERT INTO braindump_module_route_learning(user_id,module_id,workspace_id,token,project_id,task_section_id,hits,last_used_at) VALUES (?,'tasks',?,'waschen',?,?,?,?)",
                        (
                            user,
                            workspace,
                            projects[target],
                            sections[target],
                            100 if target == 0 else 5,
                            stamp,
                        ),
                    )
                db.execute(
                    "INSERT INTO braindump_module_route_learning(user_id,module_id,token,shopping_list_id,shopping_section_id,hits,last_used_at) VALUES (?,'shopping','milk',?,?,4,?)",
                    (user, listing, shelf, stamp),
                )
                older_stamp = (
                    datetime.now(timezone.utc) - timedelta(days=1)
                ).isoformat()
                for target, date in ((0, stamp), (1, older_stamp)):
                    db.execute(
                        "INSERT INTO braindump_route_learning(user_id,workspace_id,token,project_id,section_id,hits,last_used_at) VALUES (?,?,'recency',?,?,2,?)",
                        (user, workspace, projects[target], sections[target], date),
                    )
                db.execute(
                    "INSERT INTO braindump_route_learning(user_id,workspace_id,token,project_id,hits,last_used_at) VALUES (?,?,'stampzone',?,9,'2026-05-01T11:00:00+02:00')",
                    (user, workspace, projects[0]),
                )
                db.execute(
                    "INSERT INTO braindump_module_route_learning(user_id,module_id,workspace_id,token,project_id,hits,last_used_at) VALUES (?,'tasks',?,'stampzone',?,5,'2026-05-01T10:30:00+00:00')",
                    (user, workspace, projects[0]),
                )
                db.execute(
                    "INSERT INTO braindump_route_learning(user_id,token,project_id,hits,last_used_at) VALUES (?,'private',?,3,?)",
                    (disabled, projects[0], stamp),
                )
                exact = db.execute(
                    "INSERT INTO routing_memory_entries(user_id,name_key,shopping_list_id,list_known,section_known,section_id,stores_known,store_ids_json,updated_at) VALUES (?,'öl',?,1,1,?,1,'[]',?)",
                    (user, listing, shelf, stamp),
                ).lastrowid
                event = db.execute(
                    "INSERT INTO routing_memory_events(user_id,event_id,generation,created_at) VALUES (?,'pre069-event',0,?)",
                    (user, stamp),
                ).lastrowid
                for field, value in (
                    ("list", listing),
                    ("section", shelf),
                    ("stores", []),
                ):
                    db.execute(
                        "INSERT INTO routing_memory_observations(user_id,entry_id,event_id,field,value_json,observed_at) VALUES (?,?,?,?,?,?)",
                        (user, exact, event, field, json.dumps(value), stamp),
                    )
                before = {
                    table: [
                        tuple(row)
                        for row in db.execute(f"SELECT * FROM {table} ORDER BY id")
                    ]
                    for table in (
                        "routing_memory_entries",
                        "routing_memory_observations",
                        "routing_memory_events",
                        "braindump_route_learning",
                        "braindump_module_route_learning",
                    )
                }
                sql = (
                    ROOT / "api/migrations/069_unify_task_shopping_routing_memory.sql"
                ).read_text()
                try:
                    migrate.apply_atomic_migration(
                        db, sql + "\nSELECT * FROM forced069failure;", 69
                    )
                except sqlite3.OperationalError as error:
                    assert "forced069failure" in str(error)
                else:
                    raise AssertionError(
                        "Fault-injected069 migration unexpectedly succeeded"
                    )
                assert (
                    db.execute("SELECT version FROM schema_version").fetchone()[0] == 68
                )
                for table, records in before.items():
                    assert [
                        tuple(row)
                        for row in db.execute(f"SELECT * FROM {table} ORDER BY id")
                    ] == records, table
            with contextlib.redirect_stdout(io.StringIO()):
                migrate.run_migrations()
            with get_db() as db:
                assert (
                    db.execute("SELECT version FROM schema_version").fetchone()[0]
                    == max(version for version, _ in migrations)
                )
                assert not db.execute(
                    "SELECT name FROM sqlite_master WHERE name IN ('braindump_route_learning','braindump_module_route_learning')"
                ).fetchall()
                imported = db.execute(
                    "SELECT * FROM routing_memory_entries WHERE user_id=? AND key_kind='token' AND module_id='tasks' AND name_key='waschen' ORDER BY project_id",
                    (user,),
                ).fetchall()
                assert [row["legacy_hits"] for row in imported] == [
                    100,
                    7,
                ], "039/060 mirrored counters use MAX while competitors survive"
                assert all(
                    row["name_key"] == "waschen" and row["updated_at"] == stamp
                    for row in imported
                )
                assert [row["task_section_id"] for row in imported] == sections
                votes = db.execute(
                    "SELECT support_count FROM routing_memory_observations WHERE field='list' AND entry_id IN (?,?) ORDER BY support_count DESC",
                    tuple(row["id"] for row in imported),
                ).fetchall()
                assert [row[0] for row in votes] == [100, 7]
                for field in ("module", "list", "section"):
                    dates = db.execute(
                        "SELECT observation.observed_at FROM routing_memory_observations observation JOIN routing_memory_entries entry ON entry.id=observation.entry_id WHERE entry.name_key='recency' AND observation.field=? ORDER BY observation.id",
                        (field,),
                    ).fetchall()
                    assert [row[0] for row in dates] == [
                        older_stamp,
                        stamp,
                    ], "import ranks follow time, not project/group order"
                zoned = db.execute(
                    "SELECT legacy_hits,updated_at FROM routing_memory_entries WHERE name_key='stampzone'"
                ).fetchone()
                assert tuple(zoned) == (
                    9,
                    "2026-05-01T10:30:00+00:00",
                ), "MAX hits and latest real timestamp are preserved independently across timezone offsets"
                shop = next(
                    row
                    for row in routing_state(db, user)["entries"]
                    if row["key_kind"] == "token"
                )
                assert (
                    shop["name_key"] == "milk"
                    and shop["section_id"] == shelf
                    and not shop["stores_known"]
                ), "legacyNULL stores are unknown, never invented explicitnone"
                assert (
                    db.execute(
                        "SELECT id FROM routing_memory_entries WHERE key_kind='exact' AND name_key='öl'"
                    ).fetchone()[0]
                    == exact
                )
                assert (
                    db.execute(
                        "SELECT event_id FROM routing_memory_events WHERE id=?",
                        (event,),
                    ).fetchone()[0]
                    == "pre069-event"
                )
                assert (
                    not routing_state(db, disabled)["enabled"]
                    and routing_state(db, disabled)["task_entries"] == []
                )
                assert db.execute("PRAGMA foreign_key_check").fetchall() == []
                record = RoutingFeedback(**feedback(["list", "section"]))
                db.execute("BEGIN IMMEDIATE")
                from services.routing_memory import record_task_route_choice

                record_task_route_choice(
                    db, user, "Wäsche waschen", projects[1], sections[1], record
                )
                result = suggest_task_route(
                    routing_entries_for_test(db, user), "Auto waschen", workspace
                )
                assert (
                    result["project_id"] == projects[1]
                    and result["section_id"] == sections[1]
                ), "imported100hit token memory is actually updated, not covered by an exact-only overlay"


def routing_entries_for_test(db, user):
    return routing_state(db, user)["task_entries"]


def test_invalid_old_targets_do_not_poison_fresh_valid_field_choices():
    with fixture() as f:
        with get_db() as db:
            seed_token(
                db,
                f.users[0],
                "waschen",
                "tasks",
                f.projects[0],
                workspace=None,
                section=f.task_sections[0][0],
            )
            db.execute("DELETE FROM sections WHERE id=?", (f.task_sections[0][0],))
        token = next(
            row for row in state(f)["task_entries"] if row["key_kind"] == "token"
        )
        assert (
            not token["section_known"] and "section" in token["history_fields"]
        ), "unusable history stays marked and cannot fill a target"
        f.call(
            "post",
            "/api/todos",
            json={
                "title": "Wäsche waschen",
                "project_id": f.projects[0],
                "section_id": f.task_sections[0][1],
                "routing_feedback": feedback(["section"]),
            },
        )
        route = suggest_task_route(
            state(f)["task_entries"], "Auto waschen", f.workspaces[0]
        )
        assert (
            route["section_id"] == f.task_sections[0][1]
        ), "invalid100-hit legacy section must not block a newly deliberate valid section"
        create(
            f,
            "Apples",
            section=f.sections[0][0],
            stores=[f.stores[0][0]],
            routing=feedback(["list", "section", "stores"]),
        )
        with get_db() as db:
            db.execute("DELETE FROM shopping_sections WHERE id=?", (f.sections[0][0],))
            db.execute(
                "UPDATE shopping_stores SET active=0 WHERE id=?", (f.stores[0][0],)
            )
        old = next(row for row in state(f)["entries"] if row["name_key"] == "apples")
        assert not old["section_known"] and not old["stores_known"]
        create(
            f,
            "Apples",
            section=f.sections[0][1],
            stores=[f.stores[0][1]],
            routing=feedback(["section", "stores"]),
        )
        current = next(
            row for row in state(f)["entries"] if row["name_key"] == "apples"
        )
        assert current["section_known"] and current["section_id"] == f.sections[0][1]
        assert current["stores_known"] and current["store_ids"] == [
            f.stores[0][1]
        ], "inactive stores are unavailable observations, not permanent competing preferences"


def test_first_new_write_does_not_trim_imported_token_records_beyond_cache_limit():
    with fixture() as f:
        with get_db() as db:
            db.executemany(
                """INSERT INTO routing_memory_entries(user_id,module_id,key_kind,workspace_id,name_key,project_id,legacy_hits,updated_at)
                VALUES (?,'tasks','token',?,?,?,1,?)""",
                [
                    (
                        f.users[0],
                        f.workspaces[0],
                        f"legacy-{index}",
                        f.projects[0],
                        datetime.now(timezone.utc).isoformat(),
                    )
                    for index in range(2001)
                ],
            )
        create(f, "New choice", routing=feedback(["list"]))
        with get_db() as db:
            assert (
                db.execute(
                    "SELECT COUNT(*) FROM routing_memory_entries WHERE key_kind='token'"
                ).fetchone()[0]
                == 2001
            )
            assert (
                db.execute(
                    "SELECT SUM(legacy_hits) FROM routing_memory_entries WHERE key_kind='token'"
                ).fetchone()[0]
                == 2001
            )


def test_server_lookup_and_correction_reach_tokens_older_than_the_offline_catalog():
    with fixture() as f:
        stamp = datetime.now(timezone.utc).isoformat()
        with get_db() as db:
            db.executemany(
                """INSERT INTO routing_memory_entries(user_id,module_id,key_kind,workspace_id,name_key,project_id,list_known,task_section_id,section_known,legacy_hits,updated_at)
                VALUES (?,'tasks','token',?,?,?,1,?,1,100,?)""",
                [
                    (
                        f.users[0],
                        f.workspaces[0],
                        f"token{index:04d}",
                        f.projects[0],
                        f.task_sections[0][0],
                        stamp,
                    )
                    for index in range(2001)
                ],
            )
            for field, value in (
                ("list", f.projects[0]),
                ("section", f.task_sections[0][0]),
                ("module", "tasks"),
            ):
                db.execute(
                    """INSERT INTO routing_memory_observations(user_id,entry_id,field,value_json,support_count,origin,observed_at)
                    SELECT user_id,id,?,?,100,'legacy',? FROM routing_memory_entries WHERE key_kind='token'""",
                    (field, json.dumps(value), stamp),
                )
        assert "token0000" not in {
            row["name_key"] for row in state(f)["task_entries"]
        }, "offline catalog stays bounded"

        def recall():
            with get_db() as db:
                context = brain._load_braindump_extraction_context(
                    db, f.users[0], f.workspaces[0], ["tasks"]
                )
                return brain._apply_learned_routes(
                    db,
                    f.users[0],
                    f.workspaces[0],
                    {
                        "candidates": [
                            {
                                "module_id": "tasks",
                                "title": "token0000 morgen",
                                "project_name": None,
                                "section_name": None,
                                "explicit_route_fields": [],
                            }
                        ]
                    },
                    context,
                )["candidates"][0]

        assert (
            recall()["project_id"] == f.projects[0]
        ), "server recall targets names before the cache limit"
        f.call(
            "post",
            "/api/todos",
            json={
                "title": "token0000",
                "project_id": f.projects[1],
                "routing_feedback": feedback(["list"]),
            },
        )
        assert (
            recall()["project_id"] == f.projects[1]
        ), "retirement sees the old100-hit token beyond the catalog too"


def test_flat_legacy_preview_correction_uses_shared_memory_without_self_reinforcement():
    with fixture() as f:
        original = {
            "title": "Legacy flat route",
            "project_name": "Project 0",
            "section_name": "Section 0",
            "original_project_name": "Project 0",
            "original_section_name": "Section 0",
            "original_route_present": True,
        }
        with patch.object(brain, "require_braindump_access"):
            f.call(
                "post",
                "/api/braindump/v2/todos",
                json={"workspace_id": f.workspaces[0], "candidates": [original]},
            )
            assert (
                state(f)["task_entries"] == []
            ), "old unchanged acceptances do not reinforce inferred routing"
            f.call(
                "post",
                "/api/braindump/v2/todos",
                json={
                    "workspace_id": f.workspaces[0],
                    "candidates": [{**original, "section_name": "Section 1"}],
                },
            )
        entry = state(f)["task_entries"][0]
        assert (
            entry["section_known"]
            and entry["section_id"] == f.task_sections[0][1]
            and not entry["list_known"]
        )


def test_base_predictions_share_authorized_memory_without_reinforcing_it():
    with fixture() as f:
        create(
            f,
            "Butter",
            section=f.sections[0][0],
            stores=[f.stores[0][0]],
            routing=feedback(["list", "section", "stores"]),
        )
        f.call(
            "post",
            "/api/todos",
            json={
                "title": "Staubsaugen",
                "project_id": f.projects[0],
                "section_id": f.task_sections[0][0],
                "routing_feedback": feedback(["list", "section"]),
            },
        )
        before = state(f)
        with get_db() as db:
            assert (
                suggest_module(db, f.users[0], "Bio Butter", f.workspaces[0])
                == "shopping"
            )
            assert (
                suggest_module(db, f.users[0], "Bitte Staubsaugen", f.workspaces[0])
                == "tasks"
            )
            assert suggest_module(db, f.users[0], "Bitte Staubsaugen", f.work) is None
            assert suggest_module(db, f.users[1], "Bio Butter", f.workspaces[1]) is None
            context = brain._load_braindump_extraction_context(
                db, f.users[0], f.workspaces[0], ["tasks", "shopping"]
            )
            shopping_candidate = brain._apply_learned_routes(
                db,
                f.users[0],
                f.workspaces[0],
                {
                    "candidates": [
                        {
                            "module_id": "tasks",
                            "title": "Bio Butter",
                            "explicit_route_fields": [],
                        }
                    ]
                },
                context,
            )["candidates"][0]
            assert shopping_candidate["module_id"] == "shopping"
            assert shopping_candidate["shopping_list_id"] == f.lists[0]
            assert shopping_candidate["shopping_section_id"] == f.sections[0][0]
            assert set(shopping_candidate["memory_route_fields"]) == {
                "module",
                "list",
                "section",
                "stores",
            }
            task_candidate = brain._apply_learned_routes(
                db,
                f.users[0],
                f.workspaces[0],
                {
                    "candidates": [
                        {
                            "module_id": "tasks",
                            "title": "Bitte Staubsaugen",
                            "explicit_route_fields": [],
                        }
                    ]
                },
                context,
            )["candidates"][0]
            assert task_candidate["project_id"] == f.projects[0]
            assert task_candidate["section_id"] == f.task_sections[0][0]
        create(
            f,
            "Bio Butter",
            section=f.sections[0][0],
            stores=[f.stores[0][0]],
            routing=feedback([]),
        )
        after = state(f)
        assert (
            after["revision"] == before["revision"]
            and after["learned_routes"] == before["learned_routes"]
        )
        f.actor["id"] = f.users[2]
        assert (
            state(f)["entries"] == []
        ), "sharing content never shares personal learned routes"
        with get_db() as db:
            assert suggest_module(db, f.users[2], "Bio Butter", f.workspaces[0]) is None


def test_base_module_conflicts_and_revocation_do_not_restore_weaker_choices():
    with fixture() as f:
        create(f, "Butter", routing=feedback(["list"]))
        f.call(
            "post",
            "/api/todos",
            json={
                "title": "Butter",
                "project_id": f.projects[0],
                "routing_feedback": feedback(["module"]),
            },
        )
        with get_db() as db:
            assert (
                suggest_module(db, f.users[0], "Bio Butter", f.workspaces[0]) is None
            ), "conflicting base modules are not sliced into separate fake winners"
        create(f, "Bio Butter", routing=feedback(["list"]))
        with get_db() as db:
            assert (
                suggest_module(db, f.users[0], "Bio Butter", f.workspaces[0])
                == "shopping"
            ), "an exact deliberate variant wins over its base conflict"
        f.actor["id"] = f.users[2]
        create(f, "Shared Cheese", routing=feedback(["list", "section"]))
        with get_db() as db:
            assert suggest_module(db, f.users[2], "Bio Shared Cheese") == "shopping"
            remove_entity_access(
                db, "shopping_list", f.lists[0], f.users[0], f.users[2]
            )
        with get_db() as db:
            assert suggest_module(db, f.users[2], "Bio Shared Cheese") is None
        assert state(f)["entries"] == []

    with fixture() as f:
        create(f, "Butter", routing=feedback(["list"]))
        f.call(
            "post",
            "/api/todos",
            json={
                "title": "Beurre",
                "project_id": f.projects[0],
                "routing_feedback": feedback(["module"]),
            },
        )
        with get_db() as db:
            assert (
                suggest_module(db, f.users[0], "Bio Butter", f.workspaces[0])
                == "shopping"
            ), "the personal full wording is independent of other language titles"
            assert (
                suggest_module(db, f.users[0], "Bio Beurre", f.workspaces[0]) == "tasks"
            ), "the same learned full-name engine works for Tasks without product dictionaries"


def test_targeted_base_lookup_retains_old_full_names_beyond_offline_catalog():
    from services.routing_memory import routing_lookup_entries

    with fixture() as f:
        create(
            f, "Butter", section=f.sections[0][0], routing=feedback(["list", "section"])
        )
        f.call(
            "post",
            "/api/todos",
            json={
                "title": "Staubsaugen",
                "project_id": f.projects[0],
                "routing_feedback": feedback(["list"]),
            },
        )
        with get_db() as db:
            stamp = datetime.now(timezone.utc).isoformat()
            for module, target_column, target, scope in [
                ("shopping", "shopping_list_id", f.lists[0], None),
                ("tasks", "project_id", f.projects[0], f.workspaces[0]),
            ]:
                db.executemany(
                    f"INSERT INTO routing_memory_entries(user_id,module_id,name_key,{target_column},workspace_id,updated_at,update_sequence,list_sequence) VALUES (?,?,?,?,?,?,?,?)",
                    [
                        (
                            f.users[0],
                            module,
                            f"filler{index}",
                            target,
                            scope,
                            stamp,
                            10000 + index,
                            10000 + index,
                        )
                        for index in range(2001)
                    ],
                )
        assert "butter" not in {row["name_key"] for row in state(f)["entries"]}
        assert "staubsaugen" not in {
            row["name_key"] for row in state(f)["task_entries"]
        }
        with get_db() as db:
            shopping_rows = routing_lookup_entries(db, f.users[0], "unbekannte Butter")
            assert (
                suggest_route(shopping_rows, "unbekannte Butter")["section_id"]
                == f.sections[0][0]
            )
            task_rows = routing_lookup_entries(
                db, f.users[0], "Bitte Staubsaugen", "tasks"
            )
            assert (
                suggest_task_route(task_rows, "Bitte Staubsaugen", f.workspaces[0])[
                    "project_id"
                ]
                == f.projects[0]
            )


def test_imported_phrases_share_module_inference_and_personal_exceptions_without_word_lists():
    with fixture() as f:
        with get_db() as db:
            seed_token(
                db,
                f.users[0],
                "tomaten",
                "shopping",
                f.lists[0],
                section=f.sections[0][0],
            )
            for name in [
                "Bio Tomaten",
                "Tomaten pflanzen",
                "TK Tomaten",
                "2 Tomaten",
                "Alpro Tomaten",
                "getrocknete Tomaten",
            ]:
                assert (
                    suggest_module(db, f.users[0], name, f.workspaces[0]) == "shopping"
                ), "unseen modifiers cannot be semantically classified without personal examples"
        f.call(
            "post",
            "/api/todos",
            json={
                "title": "Tomaten pflanzen",
                "project_id": f.projects[0],
                "routing_feedback": feedback(["module"]),
            },
        )
        with get_db() as db:
            assert (
                suggest_module(db, f.users[0], "Tomaten pflanzen", f.workspaces[0])
                == "tasks"
            )
            context = brain._load_braindump_extraction_context(
                db, f.users[0], f.workspaces[0], ["tasks", "shopping"]
            )
            candidate = brain._apply_learned_routes(
                db,
                f.users[0],
                f.workspaces[0],
                {
                    "candidates": [
                        {
                            "module_id": "tasks",
                            "title": "Tomaten pflanzen",
                            "explicit_route_fields": [],
                        }
                    ]
                },
                context,
            )["candidates"][0]
            assert (
                candidate["module_id"] == "tasks"
            ), "the personal exact correction wins over its lossy imported phrase"
    with fixture() as f:
        with get_db() as db:
            seed_token(
                db,
                f.users[0],
                "tomaten",
                "shopping",
                f.lists[0],
                section=f.sections[0][0],
            )
            seed_token(
                db,
                f.users[0],
                "gelbe",
                "shopping",
                f.lists[1],
                section=f.sections[1][0],
            )
            assert (
                suggest_module(db, f.users[0], "gelbe Tomaten", f.workspaces[0])
                == "shopping"
            ), "both personal terms agree on the module"
        assert (
            suggest_route(state(f)["entries"], "gelbe Tomaten") is None
        ), "incomparable terms in different lists still conflict for the container field"
        with get_db() as db:
            seed_token(
                db,
                f.users[0],
                "wäsche",
                "tasks",
                f.projects[0],
                workspace=f.workspaces[0],
            )
            assert (
                suggest_module(db, f.users[0], "Wäsche xyzTK", f.workspaces[0])
                == "tasks"
            )


def test_cjk_task_politeness_recall_and_correction_update_the_applied_imported_token():
    with fixture() as f:
        with get_db() as db:
            seed_token(
                db,
                f.users[0],
                "洗衣服",
                "tasks",
                f.projects[0],
                workspace=f.workspaces[0],
                section=f.task_sections[0][0],
            )
            assert (
                suggest_module(db, f.users[0], "请洗衣服", f.workspaces[0]) == "tasks"
            )
        route = suggest_task_route(
            state(f)["task_entries"], "请洗衣服", f.workspaces[0]
        )
        assert (
            route["project_id"] == f.projects[0]
            and route["memory_sources"]["list"] == "phrase"
        )
        f.call(
            "post",
            "/api/todos",
            json={
                "title": "请洗衣服",
                "project_id": f.projects[1],
                "section_id": f.task_sections[1][1],
                "routing_feedback": feedback(["list", "section"]),
            },
        )
        route = suggest_task_route(state(f)["task_entries"], "洗衣服", f.workspaces[0])
        assert (
            route["project_id"] == f.projects[1]
            and route["section_id"] == f.task_sections[1][1]
        )
        assert (
            route["memory_sources"]["list"] == "phrase"
        ), "the old token itself was updated, not only the polite exact phrase"


def test_cjk_shopping_base_correction_updates_only_applied_imported_names():
    with fixture() as f:
        with get_db() as db:
            seed_token(
                db,
                f.users[0],
                "人造黄油",
                "shopping",
                f.lists[0],
                section=f.sections[0][0],
                stores=[f.stores[0][0]],
            )
            unused = seed_token(
                db,
                f.users[0],
                "造黄",
                "shopping",
                f.lists[0],
                section=f.sections[0][0],
            )
            unused_before = [
                tuple(row)
                for row in db.execute(
                    "SELECT * FROM routing_memory_observations WHERE entry_id=? ORDER BY id",
                    (unused,),
                )
            ]
        route = suggest_route(state(f)["entries"], "植物性人造黄油")
        assert (
            route["shopping_list_id"] == f.lists[0]
            and route["memory_sources"]["list"] == "phrase"
        )
        create(
            f,
            "植物性人造黄油",
            listing=1,
            section=f.sections[1][1],
            stores=[f.stores[1][1]],
            routing=feedback(["list", "section", "stores"]),
        )
        route = suggest_route(state(f)["entries"], "有机人造黄油")
        assert route["shopping_list_id"] == f.lists[1]
        assert route["section_id"] == f.sections[1][1] and route["store_ids"] == [
            f.stores[1][1]
        ]
        with get_db() as db:
            assert unused_before == [
                tuple(row)
                for row in db.execute(
                    "SELECT * FROM routing_memory_observations WHERE entry_id=? ORDER BY id",
                    (unused,),
                )
            ], "a shorter nested imported phrase was dominated and must not be rewritten"


def test_cjk_module_correction_updates_the_applied_politeness_token():
    with fixture() as f:
        with get_db() as db:
            seed_token(
                db,
                f.users[0],
                "洗衣服",
                "tasks",
                f.projects[0],
                workspace=f.workspaces[0],
            )
            assert (
                suggest_module(db, f.users[0], "请洗衣服", f.workspaces[0]) == "tasks"
            )
        create(f, "请洗衣服", routing=feedback(["module"]))
        with get_db() as db:
            assert (
                suggest_module(db, f.users[0], "洗衣服", f.workspaces[0]) == "shopping"
            )
        imported = [
            row
            for row in state(f)["entries"]
            if row["key_kind"] == "token" and row["name_key"] == "洗衣服"
        ]
        assert (
            len(imported) == 1 and not imported[0]["list_known"]
        ), "module-only correction does not invent a deliberate list choice"


def test_modern_base_variant_corrections_never_rewrite_unapplied_legacy_tokens():
    with fixture() as f:
        with get_db() as db:
            seed_token(
                db,
                f.users[0],
                "butter",
                "shopping",
                f.lists[0],
                section=f.sections[0][0],
                stores=[f.stores[0][0]],
            )
            seed_token(
                db,
                f.users[0],
                "洗衣服",
                "tasks",
                f.projects[0],
                workspace=f.workspaces[0],
                section=f.task_sections[0][0],
            )
        create(
            f,
            "Butter",
            section=f.sections[0][0],
            stores=[f.stores[0][0]],
            routing=feedback(["list", "section", "stores"]),
        )
        f.call(
            "post",
            "/api/todos",
            json={
                "title": "洗衣服",
                "project_id": f.projects[0],
                "section_id": f.task_sections[0][0],
                "routing_feedback": feedback(["list", "section"]),
            },
        )
        with get_db() as db:
            before = [
                tuple(row)
                for row in db.execute(
                    "SELECT observation.* FROM routing_memory_observations observation JOIN routing_memory_entries entry ON entry.id=observation.entry_id WHERE entry.user_id=? AND entry.key_kind='token' ORDER BY observation.id",
                    (f.users[0],),
                )
            ]
        create(
            f,
            "Bio Butter",
            listing=1,
            section=f.sections[1][1],
            stores=[f.stores[1][1]],
            routing=feedback(["list", "section", "stores"]),
        )
        f.call(
            "post",
            "/api/todos",
            json={
                "title": "请洗衣服",
                "project_id": f.projects[1],
                "section_id": f.task_sections[1][1],
                "routing_feedback": feedback(["list", "section"]),
            },
        )
        with get_db() as db:
            after = [
                tuple(row)
                for row in db.execute(
                    "SELECT observation.* FROM routing_memory_observations observation JOIN routing_memory_entries entry ON entry.id=observation.entry_id WHERE entry.user_id=? AND entry.key_kind='token' ORDER BY observation.id",
                    (f.users[0],),
                )
            ]
        assert (
            before == after
        ), "modern exact/base suggestions are personal full-name variants, never broad token reinforcement"
        entries = state(f)
        assert (
            suggest_route(entries["entries"], "Butter")["shopping_list_id"]
            == f.lists[0]
        )
        assert (
            suggest_route(entries["entries"], "Bio Butter")["shopping_list_id"]
            == f.lists[1]
        )
        assert (
            suggest_task_route(entries["task_entries"], "洗衣服", f.workspaces[0])[
                "project_id"
            ]
            == f.projects[0]
        )
        assert (
            suggest_task_route(entries["task_entries"], "请洗衣服", f.workspaces[0])[
                "project_id"
            ]
            == f.projects[1]
        )


def test_modern_personal_corpus_overlap_is_shared_by_api_and_braindump_without_relearning():
    with fixture() as f:
        for title, index in [("Wäsche waschen", 0), ("Auto waschen", 1)]:
            f.call(
                "post",
                "/api/todos",
                json={
                    "title": title,
                    "project_id": f.projects[index],
                    "section_id": f.task_sections[index][0],
                    "routing_feedback": feedback(["list", "section"]),
                },
            )
        before = state(f)
        route = suggest_task_route(
            before["task_entries"], "Wäsche machen", f.workspaces[0]
        )
        assert (
            route["project_id"] == f.projects[0]
            and route["memory_sources"]["list"] == "statistical"
        )
        for title in ("Wäsche trocknen", "Wäsche falten"):
            f.call(
                "post",
                "/api/todos",
                json={
                    "title": title,
                    "project_id": f.projects[0],
                    "section_id": f.task_sections[0][0],
                    "routing_feedback": feedback(["list", "section"]),
                },
            )
            before = state(f)
            route = suggest_task_route(
                before["task_entries"], "Wäsche machen", f.workspaces[0]
            )
            assert (
                route["project_id"] == f.projects[0]
                and route["section_id"] == f.task_sections[0][0]
            ), "additional consistent personal examples keep the learned proposal usable"
        with get_db() as db:
            context = brain._load_braindump_extraction_context(
                db, f.users[0], f.workspaces[0], ["tasks"]
            )
            candidate = brain._apply_learned_routes(
                db,
                f.users[0],
                f.workspaces[0],
                {
                    "candidates": [
                        {
                            "module_id": "tasks",
                            "title": "Wäsche machen",
                            "explicit_route_fields": [],
                        }
                    ]
                },
                context,
            )["candidates"][0]
            assert (
                candidate["project_id"] == route["project_id"]
                and candidate["section_id"] == route["section_id"]
            )
        f.call(
            "post",
            "/api/todos",
            json={
                "title": "Wäsche machen",
                "project_id": route["project_id"],
                "section_id": route["section_id"],
                "routing_feedback": feedback([]),
            },
        )
        assert (
            state(f)["revision"] == before["revision"]
        ), "statistical auto-fill never reinforces itself"


def test_typo_shopping_predictions_persist_after_list_only_explicit_learning_without_self_reinforcement():
    with fixture() as f:
        create(
            f,
            "Margerine",
            section=f.sections[0][0],
            stores=[f.stores[0][0]],
            routing=feedback(["list", "section", "stores"]),
        )
        before = state(f)
        route = suggest_route(before["entries"], "Pflanzliche Margarine")
        assert (
            route["shopping_list_id"] == f.lists[0]
            and route["section_id"] == f.sections[0][0]
            and route["store_ids"] == [f.stores[0][0]]
        )
        assert route["memory_sources"] == {
            "list": "typo",
            "section": "typo",
            "stores": "typo",
        }
        create(
            f,
            "Pflanzliche Margarine",
            section=route["section_id"],
            stores=route["store_ids"],
            routing=feedback(["list"]),
        )
        entries = state(f)
        route = suggest_route(entries["entries"], "Pflanzliche Margarine")
        assert route["memory_sources"] == {
            "list": "exact",
            "section": "typo",
            "stores": "typo",
        }
        assert route["section_id"] == f.sections[0][0] and route["store_ids"] == [
            f.stores[0][0]
        ]
        with get_db() as db:
            context = brain._load_braindump_extraction_context(
                db, f.users[0], f.workspaces[0], ["shopping"]
            )
            candidate = brain._apply_learned_routes(
                db,
                f.users[0],
                f.workspaces[0],
                {
                    "candidates": [
                        {
                            "module_id": "shopping",
                            "title": "Pflanzliche Margarine",
                            "explicit_route_fields": [],
                        }
                    ]
                },
                context,
            )["candidates"][0]
            assert (
                candidate["shopping_list_id"] == route["shopping_list_id"]
                and candidate["shopping_section_id"] == route["section_id"]
                and candidate["shopping_store_ids"] == route["store_ids"]
            )
            assert candidate["memory_route_fields"] == ["list", "section", "stores"]
        item = create(
            f,
            "Pflanzliche Margarine",
            section=route["section_id"],
            stores=route["store_ids"],
            routing=feedback([]),
        )
        assert (
            item["name"] == "Pflanzliche Margarine"
            and state(f)["revision"] == entries["revision"]
        ), "typo prediction never renames or reinforces the supplied title"


def test_unique_typo_correction_learns_new_full_title_without_changing_imported_person():
    with fixture() as f:
        with get_db() as db:
            old = seed_token(
                db,
                f.users[0],
                "christian",
                "tasks",
                f.projects[0],
                workspace=f.workspaces[0],
                section=f.task_sections[0][0],
            )
            before = [
                tuple(row)
                for row in db.execute(
                    "SELECT * FROM routing_memory_observations WHERE entry_id=? ORDER BY id",
                    (old,),
                )
            ]
        route = suggest_task_route(
            state(f)["task_entries"], "Christina", f.workspaces[0]
        )
        assert route["project_id"] == f.projects[0] and route["match_kind"] == "typo"
        body = {
            "title": "Christina",
            "project_id": f.projects[1],
            "section_id": f.task_sections[1][1],
            "client_mutation_id": "unique-person-typo",
            "routing_feedback": feedback(["list", "section"]),
        }
        created = f.call("post", "/api/todos", json=body)
        saved = state(f)
        assert created["title"] == "Christina"
        assert (
            f.call("post", "/api/todos", json=body)["id"] == created["id"]
            and state(f)["revision"] == saved["revision"]
        )
        with get_db() as db:
            assert before == [
                tuple(row)
                for row in db.execute(
                    "SELECT * FROM routing_memory_observations WHERE entry_id=? ORDER BY id",
                    (old,),
                )
            ], "a plausible spelling is not proof that two people are identical"
        assert (
            suggest_task_route(saved["task_entries"], "Christian", f.workspaces[0])[
                "project_id"
            ]
            == f.projects[0]
        )
        assert (
            suggest_task_route(saved["task_entries"], "Christina", f.workspaces[0])[
                "project_id"
            ]
            == f.projects[1]
        )


def test_ambiguous_typo_feedback_never_propagates_or_retires_any_imported_candidates():
    from services.routing_matcher import match_field

    with fixture() as f:
        with get_db() as db:
            for name, index in [("margarine", 0), ("margerine", 1)]:
                seed_token(
                    db,
                    f.users[0],
                    name,
                    "shopping",
                    f.lists[index],
                    section=f.sections[index][0],
                    stores=[f.stores[index][0]],
                )
            before = [
                tuple(row)
                for row in db.execute(
                    "SELECT observation.* FROM routing_memory_observations observation JOIN routing_memory_entries entry ON entry.id=observation.entry_id WHERE entry.user_id=? AND entry.key_kind='token' ORDER BY observation.id",
                    (f.users[0],),
                )
            ]
        entries = state(f)["entries"]
        for field in ["list", "section", "stores"]:
            result = match_field(
                entries, "Margirine", field, None if field == "list" else f.lists[0]
            )
            assert (
                result["status"] == "blocked"
                and result["match_kind"] == "typo"
                and result["source_keys"] == []
            )
        create(
            f,
            "Margirine",
            section=f.sections[0][1],
            stores=[],
            routing=feedback(["list", "section", "stores"]),
        )
        with get_db() as db:
            after = [
                tuple(row)
                for row in db.execute(
                    "SELECT observation.* FROM routing_memory_observations observation JOIN routing_memory_entries entry ON entry.id=observation.entry_id WHERE entry.user_id=? AND entry.key_kind='token' ORDER BY observation.id",
                    (f.users[0],),
                )
            ]
        assert (
            before == after
        ), "rejected ambiguous candidates never become applied correction provenance"
        route = suggest_route(state(f)["entries"], "Margirine")
        assert (
            route["shopping_list_id"] == f.lists[0]
            and route["section_id"] == f.sections[0][1]
            and route["store_ids"] == []
        )


def test_typo_suggestions_do_not_cross_accounts_or_revoked_entity_access():
    with fixture() as f:
        create(f, "Margerine", routing=feedback(["list", "section"]))
        f.actor["id"] = f.users[2]
        assert suggest_route(state(f)["entries"], "Margarine") is None
        create(f, "Margerine", routing=feedback(["list", "section"]))
        assert (
            suggest_route(state(f)["entries"], "Margarine")["shopping_list_id"]
            == f.lists[0]
        )
        with get_db() as db:
            remove_entity_access(
                db, "shopping_list", f.lists[0], f.users[0], f.users[2]
            )
        assert (
            state(f)["entries"] == []
            and suggest_route(state(f)["entries"], "Margarine") is None
        )


def test_unversioned_legacy_replays_after_reset_preserve_content_without_relearning():
    with fixture() as f:
        item = create(f)
        f.call("patch", f"/api/shopping/items/{item['id']}", json={
            "section_id": f.sections[0][0], "store_ids": [f.stores[0][0]],
        })
        task = f.call("post", "/api/todos", json={
            "title": "Legacy task", "project_id": f.projects[0],
            "section_id": f.task_sections[0][0],
        })
        f.call("patch", f"/api/todos/{task['id']}", json={
            "section_id": f.task_sections[0][1],
        })
        initial = state(f)
        assert initial["generation"] == 0
        assert initial["entries"][0]["section_known"]
        assert initial["task_entries"][0]["section_known"]

        reset = f.call("delete", "/api/routing-memory")
        assert reset["generation"] == 1
        shopping_result = f.call("patch", f"/api/shopping/items/{item['id']}", json={
            "section_id": f.sections[0][1], "store_ids": [f.stores[0][1]],
        })
        task_result = f.call("patch", f"/api/todos/{task['id']}", json={
            "project_id": f.projects[1], "section_id": f.task_sections[1][0],
        })
        assert shopping_result["section_id"] == f.sections[0][1]
        assert shopping_result["store_ids"] == [f.stores[0][1]]
        assert task_result["project_id"] == f.projects[1]
        assert task_result["section_id"] == f.task_sections[1][0]
        after = state(f)
        assert after["entries"] == after["task_entries"] == [], (
            "pre-reset unversioned PATCHes may save content, never recreate memory"
        )

        # Current clients remain able to learn immediately in the new epoch.
        f.call("patch", f"/api/shopping/items/{item['id']}", json={
            "section_id": f.sections[0][0], "store_ids": [f.stores[0][0]],
            "routing_feedback": feedback(["list", "section", "stores"], generation=1),
        })
        f.call("patch", f"/api/todos/{task['id']}", json={
            "project_id": f.projects[0], "section_id": f.task_sections[0][0],
            "routing_feedback": feedback(["list", "section"], generation=1),
        })
        current = state(f)
        assert current["entries"][0]["section_id"] == f.sections[0][0]
        assert current["task_entries"][0]["project_id"] == f.projects[0]
        assert current["task_entries"][0]["section_id"] == f.task_sections[0][0]


def test_legacy_braindump_corrections_cannot_recreate_forgotten_memory():
    with fixture() as f:
        f.call("delete", "/api/routing-memory")
        old_shopping = {
            "name": "Old BrainDump shopping", "section_id": f.sections[0][0],
            "braindump_route": {
                "original_module_id": "shopping", "original_route_present": True,
                "original_shopping_list_id": f.lists[0],
                "original_shopping_section_id": None,
            },
        }
        saved = f.call("post", f"/api/shopping/lists/{f.lists[0]}/items", json=old_shopping)
        assert saved["section_id"] == f.sections[0][0]
        with patch.object(brain, "require_braindump_access", return_value=None):
            created = f.call("post", "/api/braindump/v2/todos", json={
                "workspace_id": f.workspaces[0], "candidates": [{
                    "title": "Old BrainDump task", "project_name": "Project 0",
                    "section_name": "Section 0", "original_route_present": True,
                    "original_project_name": "Project 1",
                }],
            })
        assert len(created["todos"]) == 1
        assert created["todos"][0]["project_id"] == f.projects[0]
        assert state(f)["entries"] == state(f)["task_entries"] == []


class _HistoryReadTrace:
    def __init__(self, db):
        self.db = db
        self.batches = []

    def execute(self, sql, parameters=()):
        cursor = self.db.execute(sql, parameters)
        if "SELECT observation.*, entry.name_key" not in sql:
            return cursor
        rows = cursor.fetchall()
        self.batches.append(rows)
        return SimpleNamespace(fetchall=lambda: rows)


def test_catalog_history_reads_materialize_only_selected_authorized_entries():
    from services import routing_memory as memory_service
    with fixture() as f:
        with get_db() as db:
            for index in range(30):
                seed_token(db, f.users[0], f"source-{index}", "shopping", f.lists[0])
            traced = _HistoryReadTrace(db)
            with patch.object(memory_service, "MAX_ENTRIES", 3):
                entries = memory_service.routing_entries(traced, f.users[0])
            names = {entry["name_key"] for entry in entries}
            read_names = {row["name_key"] for batch in traced.batches for row in batch}
            assert len(names) == 3
            assert read_names == names, "out-of-catalog legacy history is not materialized"
            assert sum(map(len, traced.batches)) == 6, "only list/child fields are materialized"


def test_catalog_history_read_chunks_preserve_all_selected_observations():
    from services.routing_memory import routing_entries
    with fixture() as f:
        with get_db() as db:
            for index in range(150):
                seed_token(db, f.users[0], f"chunk-source-{index}", "shopping", f.lists[0])
            traced = _HistoryReadTrace(db)
            entries = routing_entries(traced, f.users[0])
            assert len(entries) == 150
            assert len(traced.batches) == 4, "list and child queries each use bounded ID chunks"
            assert sum(map(len, traced.batches)) == 300
            assert all(entry["preferred"] and entry["section_known"] for entry in entries)


def test_bounded_catalog_and_focused_recall_share_complete_authorized_winners():
    from services import routing_memory as memory_service
    with fixture() as f:
        with get_db() as db:
            for module, name, first, second, first_section, second_section in [
                ("shopping", "margerine", f.lists[0], f.lists[1], f.sections[0][0], f.sections[1][0]),
                ("tasks", "staubsaugen", f.projects[0], f.projects[1], f.task_sections[0][0], f.task_sections[1][0]),
            ]:
                if module == "tasks":
                    seed_token(db, f.users[0], name, module, f.projects[2],
                               workspace=f.work, section=f.task_sections[2][0], hits=10000)
                seed_token(db, f.users[0], name, module, first, section=first_section, hits=100)
                for index in range(3):
                    seed_token(db, f.users[0], f"{module}-filler-{index}", module, first,
                               workspace=f.workspaces[0] if module == "tasks" else None)
                seed_token(db, f.users[0], name, module, second, section=second_section, hits=1,
                           workspace=f.workspaces[0] if module == "tasks" else None)
                with patch.object(memory_service, "MAX_ENTRIES", 3):
                    catalog = memory_service.routing_catalog_entries(db, f.users[0], module)
                    lookup = memory_service.routing_lookup_entries(db, f.users[0], name, module)
                assert len(catalog) == 3, "replacing a recent loser preserves the catalog bound"
                assert [row for row in lookup if not row.get("inference_direct_only")] == catalog
                if module == "shopping":
                    offline = suggest_route(catalog, name)
                    online = suggest_route(lookup, name)
                    fixed = suggest_route(lookup, name, second)
                    column = "shopping_list_id"
                else:
                    offline = suggest_task_route(catalog, name, f.workspaces[0])
                    online = suggest_task_route(lookup, name, f.workspaces[0])
                    fixed = suggest_task_route(lookup, name, f.workspaces[0], second)
                    column = "project_id"
                assert offline[column] == online[column] == first
                assert offline["section_id"] == online["section_id"] == first_section
                assert fixed[column] == second and fixed["section_id"] == second_section


def test_complete_catalog_competition_never_votes_for_revoked_targets():
    from services import routing_memory as memory_service
    with fixture() as f:
        with get_db() as db:
            grant_entity_access(db, "shopping_list", f.lists[2], f.users[1], f.users[0])
            seed_token(db, f.users[0], "margerine", "shopping", f.lists[2], hits=100)
            for index in range(3):
                seed_token(db, f.users[0], f"filler-{index}", "shopping", f.lists[0])
            seed_token(db, f.users[0], "margerine", "shopping", f.lists[1], hits=1)
            with patch.object(memory_service, "MAX_ENTRIES", 3):
                assert suggest_route(memory_service.routing_catalog_entries(db, f.users[0]), "margerine")["shopping_list_id"] == f.lists[2]
                remove_entity_access(db, "shopping_list", f.lists[2], f.users[1], f.users[0])
                catalog = memory_service.routing_catalog_entries(db, f.users[0])
                assert all(row["shopping_list_id"] != f.lists[2] for row in catalog)
                assert suggest_route(catalog, "margerine")["shopping_list_id"] == f.lists[1]


def test_module_confidence_includes_older_authorized_targets_of_catalog_names():
    from services import routing_memory as memory_service
    with fixture() as f:
        with get_db() as db:
            old = seed_token(db, f.users[0], "routines", "tasks", f.projects[0],
                             workspace=f.workspaces[0], hits=100)
            db.execute("UPDATE routing_memory_observations SET support_count=1 WHERE entry_id=? AND field='list'", (old,))
            for index in range(3):
                seed_token(db, f.users[0], f"filler-{index}", "tasks", f.projects[0], workspace=f.workspaces[0])
            recent = seed_token(db, f.users[0], "routines", "tasks", f.projects[1],
                                workspace=f.workspaces[0], hits=100)
            db.execute("UPDATE routing_memory_observations SET support_count=1 WHERE entry_id=? AND field='module'", (recent,))
            seed_token(db, f.users[0], "routines", "shopping", f.lists[0], hits=10)
            # Another workspace and an inaccessible shopping list must not vote.
            seed_token(db, f.users[0], "routines", "tasks", f.projects[2], workspace=f.work, hits=10000)
            seed_token(db, f.users[0], "routines", "shopping", f.lists[2], hits=10000)
            with patch.object(memory_service, "MAX_ENTRIES", 3):
                assert memory_service.suggest_module(db, f.users[0], "routinse", f.workspaces[0]) == "tasks"


def test_070_canonical_name_collision_merge_preserves_evidence_receipts_and_rollback():
    files = migrate.get_migration_files()
    with patch.object(migrate, "get_migration_files", return_value=[item for item in files if item[0] <= 69]), fixture() as f:
        with get_db() as db:
            canonical = seed_token(db, f.users[0], "salz", "shopping", f.lists[0], hits=7, section=f.sections[0][0])
            wide = seed_token(db, f.users[0], "ｓａｌｚ", "shopping", f.lists[0], hits=100, section=f.sections[0][1])
            seed_token(db, f.users[0], "ｓａｌｚ", "shopping", f.lists[1], hits=5)
            seed_token(db, f.users[1], "salz", "shopping", f.lists[2], hits=13)
            seed_token(db, f.users[0], "ｓａｌｚ", "tasks", f.projects[0], workspace=f.workspaces[0], hits=11)
            seed_token(db, f.users[0], "ｓａｌｚ", "tasks", f.projects[2], workspace=f.work, hits=17)
            db.execute("UPDATE routing_memory_entries SET list_sequence=1,update_sequence=2,updated_at='2026-01-01T10:00:00Z' WHERE id=?", (canonical,))
            db.execute("UPDATE routing_memory_entries SET list_sequence=4,update_sequence=5,updated_at='2026-02-01T11:00:00+01:00' WHERE id=?", (wide,))
            stamp = "2026-02-02T12:00:00Z"
            for event_name, field, values, weights in [
                ("same-receipt", "section", [f.sections[0][0]] * 2, [1, 1]),
                ("different-weight", "section", [f.sections[0][0]] * 2, [1, 3]),
                ("conflicting-value", "stores", [[f.stores[0][0]], []], [1, 1]),
            ]:
                event = db.execute("INSERT INTO routing_memory_events(user_id,event_id,generation,created_at) VALUES (?,?,0,?)", (f.users[0], event_name, stamp)).lastrowid
                for entry, value, weight in zip([canonical, wide], values, weights):
                    db.execute("INSERT INTO routing_memory_observations(user_id,entry_id,event_id,field,value_json,weight,observed_at) VALUES (?,?,?,?,?,?,?)", (f.users[0], entry, event, field, json.dumps(value), weight, stamp))
            db.execute("UPDATE users SET routing_memory_generation=9,braindump_learning_enabled=0 WHERE id=?", (f.users[1],))
            tables = ["users", "routing_memory_entries", "routing_memory_observations", "routing_memory_events"]
            before = {table: [dict(row) for row in db.execute(f"SELECT * FROM {table} ORDER BY id")] for table in tables}
            sql = (ROOT / "api/migrations/070_canonicalize_routing_memory_names.sql").read_text()
            try:
                migrate.apply_atomic_migration(db, sql + "\nSELECT * FROM forced070failure;", 70)
            except sqlite3.OperationalError as error:
                assert "forced070failure" in str(error)
            else:
                raise AssertionError("Fault-injected 070 migration unexpectedly succeeded")
            assert db.execute("SELECT version FROM schema_version").fetchone()[0] == 69
            for table, rows in before.items():
                assert [dict(row) for row in db.execute(f"SELECT * FROM {table} ORDER BY id")] == rows, table
            assert not db.execute("SELECT name FROM sqlite_temp_master WHERE name='routing_memory_name_merge'").fetchall()
            assert not db.execute("SELECT name FROM sqlite_master WHERE name='idx_routing_memory_lookup_name'").fetchall()
            migrate.apply_atomic_migration(db, sql, 70)
            assert db.execute("SELECT version FROM schema_version").fetchone()[0] == 70
            merged = db.execute("SELECT * FROM routing_memory_entries WHERE id=?", (canonical,)).fetchone()
            assert merged["name_key"] == "salz" and merged["legacy_hits"] == 107
            assert merged["list_sequence"] == 4 and merged["update_sequence"] == 5
            assert merged["updated_at"] == "2026-02-01T11:00:00+01:00"
            assert not db.execute("SELECT 1 FROM routing_memory_entries WHERE id=?", (wide,)).fetchone()
            assert db.execute("SELECT COUNT(*) FROM routing_memory_entries").fetchone()[0] == len(before["routing_memory_entries"]) - 1
            assert {row[0] for row in db.execute("SELECT name_key FROM routing_memory_entries")} == {"salz"}
            assert [dict(row) for row in db.execute("SELECT * FROM users ORDER BY id")] == before["users"]
            assert [dict(row) for row in db.execute("SELECT * FROM routing_memory_events ORDER BY id")] == before["routing_memory_events"]
            after = {row["id"]: dict(row) for row in db.execute("SELECT * FROM routing_memory_observations")}
            assert len(after) == len(before["routing_memory_observations"]) - 1
            duplicate_ids = [row["id"] for row in before["routing_memory_observations"] if row["event_id"] == before["routing_memory_events"][0]["id"]]
            assert min(duplicate_ids) in after and max(duplicate_ids) not in after
            for original in before["routing_memory_observations"]:
                if original["id"] not in after:
                    assert original["id"] == max(duplicate_ids)
                    continue
                actual = after[original["id"]]
                assert actual["entry_id"] == (canonical if original["entry_id"] == wide else original["entry_id"])
                assert actual["event_id"] in (original["event_id"], None)
                if original["event_id"] is None:
                    assert actual["event_id"] is None, "independent legacy support is never fabricated/deduplicated"
                for key in set(original) - {"entry_id", "event_id"}:
                    assert actual[key] == original[key], (key, original["id"])
            assert not db.execute("PRAGMA foreign_key_check").fetchall()


def test_real_068_upgrade_canonicalizes_legacy_tokens_before_correction_and_hidden_recall():
    from services import routing_memory as memory_service
    files = migrate.get_migration_files()
    with patch.object(migrate, "get_migration_files", return_value=[item for item in files if item[0] <= 68]), fixture() as f:
        with get_db() as db:
            for token, hits in [("ｓａｌｚ", 100), ("ｚｕｃｋｅｒ", 20)]:
                db.execute("INSERT INTO braindump_module_route_learning(user_id,token,module_id,shopping_list_id,shopping_section_id,hits,last_used_at) VALUES (?,?,'shopping',?,?,?,datetime('now'))", (f.users[0], token, f.lists[0], f.sections[0][0], hits))
        with patch.object(migrate, "get_migration_files", return_value=[item for item in files if item[0] <= 69]), contextlib.redirect_stdout(io.StringIO()):
            migrate.run_migrations()
        with get_db() as db:
            assert {row[0] for row in db.execute("SELECT name_key FROM routing_memory_entries")} == {"ｓａｌｚ", "ｚｕｃｋｅｒ"}
        with patch.object(migrate, "get_migration_files", return_value=files), contextlib.redirect_stdout(io.StringIO()):
            migrate.run_migrations()
        with get_db() as db:
            assert db.execute("SELECT version FROM schema_version").fetchone()[0] == max(version for version, _ in files)
            assert {row[0] for row in db.execute("SELECT name_key FROM routing_memory_entries")} == {"salz", "zucker"}
        assert suggest_route(state(f)["entries"], "Salz kaufen")["shopping_list_id"] == f.lists[0]
        create(f, "Salz kaufen", listing=1, section=f.sections[1][0], routing=feedback(["list", "section"]))
        learned = suggest_route(state(f)["entries"], "Salz essen")
        assert learned["shopping_list_id"] == f.lists[1] and learned["section_id"] == f.sections[1][0]
        with get_db() as db:
            assert db.execute("SELECT SUM(legacy_hits) FROM routing_memory_entries").fetchone()[0] == 120
            for index in range(4):
                seed_token(db, f.users[0], f"hidden-filler-{index}", "shopping", f.lists[0])
            with patch.object(memory_service, "MAX_ENTRIES", 3):
                catalog = memory_service.routing_catalog_entries(db, f.users[0])
                assert "zucker" not in {row["name_key"] for row in catalog}
                lookup = memory_service.routing_lookup_entries(db, f.users[0], "Zucker kaufen")
                route = suggest_route(lookup, "Zucker kaufen")
                assert route["shopping_list_id"] == f.lists[0] and route["section_id"] == f.sections[0][0]
            assert not db.execute("PRAGMA foreign_key_check").fetchall()


if __name__ == "__main__":
    tests = [
        value
        for name, value in globals().items()
        if name.startswith("test_") and callable(value)
    ]
    for test in tests:
        test()
        print(f"✅ {test.__name__}")
    print(f"Shared routing memory passed: {len(tests)}/{len(tests)}")
