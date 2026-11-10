#!/usr/bin/env python3
"""Recipe transfers on full migrations and exclusively disposable databases.

The coordinator runs this script serially. It never uses the installed Nia
database, its service, real accounts, files or external model/image providers.
"""

import asyncio
import contextlib
import copy
import io
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
TEST_ROOT = tempfile.TemporaryDirectory(prefix="nia-recipe-transfer-tests-")
os.environ.update({
    "NIA_TODO_DATA_DIR": TEST_ROOT.name,
    "NIA_TODO_DB": str(Path(TEST_ROOT.name) / "unused.db"),
    "NIA_TODO_ATTACHMENT_DIR": str(Path(TEST_ROOT.name) / "attachments"),
    "NIA_TODO_AVATAR_DIR": str(Path(TEST_ROOT.name) / "avatars"),
    "NIA_TODO_BACKUP_DIR": str(Path(TEST_ROOT.name) / "backups"),
    "NIA_TODO_VAPID_KEYS": str(Path(TEST_ROOT.name) / "vapid.json"),
})
sys.path.insert(0, str(ROOT / "api"))

from fastapi import FastAPI
from fastapi.testclient import TestClient
import db as database
import migrate
from db import get_db
from routers import recipes, shopping
from routers.auth import require_auth
from services import recipe_shopping_transfer as transfers
from services.entity_access import (
    create_household, grant_entity_access, invite_entity_access, invite_household_member,
    register_household_entity, register_personal_entity, remove_entity_access,
    respond_to_entity_invite, respond_to_household_invite,
)
from services.quantity_units import convert_quantity


@contextlib.contextmanager
def fixture():
    with tempfile.TemporaryDirectory(dir=TEST_ROOT.name) as directory:
        path = Path(directory) / "transfer.db"
        with patch.object(database, "DB_PATH", path), patch.object(migrate, "DB_PATH", path), \
             patch.object(recipes, "broadcast_sync_to_users", new=AsyncMock()) as broadcasts, \
             patch.object(shopping, "_broadcast_item_change", new=AsyncMock()):
            with contextlib.redirect_stdout(io.StringIO()):
                migrate.run_migrations()
            with get_db() as db:
                users = [db.execute("INSERT INTO users (username) VALUES (?)", (f"transfer-user-{n}",)).lastrowid for n in range(5)]
                book = db.execute("INSERT INTO cookbooks (name,created_by_user_id) VALUES ('Source cookbook',?)", (users[0],)).lastrowid
                register_personal_entity(db, "cookbook", book, users[0])
                lists, sections, stores = [], [], []
                for index, owner in enumerate((users[0], users[3])):
                    listing = db.execute("INSERT INTO shopping_lists (name,created_by_user_id) VALUES (?,?)", (f"List {index}", owner)).lastrowid
                    register_personal_entity(db, "shopping_list", listing, owner)
                    lists.append(listing)
                    sections.append(db.execute("INSERT INTO shopping_sections (shopping_list_id,name) VALUES (?,'Shelf')", (listing,)).lastrowid)
                    stores.append(db.execute("INSERT INTO shopping_stores (shopping_list_id,name) VALUES (?,'Store')", (listing,)).lastrowid)
                for entity_type, entity_id in (("cookbook", book), ("shopping_list", lists[0])):
                    invite = invite_entity_access(db, entity_type, entity_id, users[0], users[1])
                    respond_to_entity_invite(db, entity_type, entity_id, invite["id"], users[1], accept=True)
                    invite_entity_access(db, entity_type, entity_id, users[0], users[2])
                grant_entity_access(db, "shopping_list", lists[0], users[0], users[4])
            actor = {"id": users[0]}
            app = FastAPI()
            app.include_router(recipes.router)
            app.include_router(shopping.router)
            app.dependency_overrides[require_auth] = lambda: actor["id"]
            with TestClient(app, raise_server_exceptions=False) as client:
                def call(method, endpoint, expected=200, **kwargs):
                    response = getattr(client, method)(endpoint, **kwargs)
                    assert response.status_code == expected, (method, endpoint, response.status_code, response.text)
                    return response.json() if expected != 500 else response
                yield SimpleNamespace(path=path, users=users, book=book, lists=lists, sections=sections, stores=stores,
                                      actor=actor, client=client, call=call, broadcasts=broadcasts)


def recipe_payload(cmi="source-create"):
    return {"client_mutation_id": cmi, "title": "Shared source meal", "base_servings": 4,
            "ingredient_groups": [{"client_key": "main", "name": "Main", "ingredients": [
                {"client_key": "flour", "name": " Flour ", "quantity_value": 250, "quantity_unit": "grams", "note": "Sifted"},
                {"client_key": "milk", "name": "Milk", "quantity_value": 500, "quantity_unit": "ml"},
                {"client_key": "salt", "name": "Salt", "quantity_text": "to taste", "note": "Keep dry"},
                {"client_key": "pepper", "name": "Pepper"},
                {"client_key": "spoon", "name": "Water", "quantity_value": 1, "quantity_unit": "TL"},
            ]}], "steps": []}


def create_recipe(f, payload=None):
    return f.call("post", f"/api/recipes/cookbooks/{f.book}/recipes", json=payload or recipe_payload())


def request(f, *, keys=("flour", "milk"), cmi="transfer-1", servings=8, revision=1):
    return {"shopping_list_id": f.lists[0], "servings": servings, "expected_revision": revision,
            "client_mutation_id": cmi, "ingredients": [
                {"ingredient_client_key": key, "section_id": f.sections[0], "store_ids": [f.stores[0]]} for key in keys]}


def transfer(f, source, data=None, expected=200):
    return f.call("post", f"/api/recipes/recipes/{source['id']}/shopping-transfer", expected=expected, json=data or request(f))


def item(f, name, value=None, unit=None, *, note="", text=None, section=None, stores=None):
    return f.call("post", f"/api/shopping/lists/{f.lists[0]}/items", json={
        "name": name, "quantity_value": value, "quantity_unit": unit, "quantity_text": text, "note": note,
        "section_id": f.sections[0] if section is None else section,
        "store_ids": [f.stores[0]] if stores is None else stores,
    })


def counts():
    with get_db() as db:
        return tuple(db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                     for table in ("shopping_items", "recipe_shopping_transfers", "shopping_item_recipe_sources"))


def test_scale_merge_and_completed_rows():
    with fixture() as f:
        source = create_recipe(f)
        source_before = f.call("get", f"/api/recipes/recipes/{source['id']}")
        flour = item(f, "flour", .5, "kg", note="Sifted")
        milk = item(f, "MILK", 1, "l")
        completed = item(f, "Flour", 8, "kg", note="Sifted")
        f.call("patch", f"/api/shopping/items/{completed['id']}", json={"completed": True})
        before_completed = f.call("get", f"/api/shopping/lists/{f.lists[0]}")["items"][-1]
        result = transfer(f, source)
        assert (result["created_count"], result["merged_count"], result["source_revision"]) == (0, 2, 1)
        rows = {row["id"]: row for row in result["shopping_list"]["items"]}
        assert rows[flour["id"]]["quantity_value"] == 1 and rows[flour["id"]]["quantity_unit"] == "kg"
        assert rows[milk["id"]]["quantity_value"] == 2 and rows[milk["id"]]["quantity_unit"] == "l"
        assert rows[completed["id"]] == before_completed
        origin = rows[flour["id"]]["recipe_sources"][0]
        assert origin["recipe_id"] == source["id"] and origin["recipe_title"] == source["title"]
        assert origin["ingredient_client_key"] == "flour" and origin["quantity_value"] == 500
        assert origin["base_servings"] == 4 and origin["servings"] == 8 and origin["note"] == "Sifted"
        assert f.call("get", f"/api/recipes/recipes/{source['id']}") == source_before
        f.call("patch", f"/api/shopping/items/{flour['id']}", json={"name": "Manual edit", "quantity_value": 7, "note": "Manual note"})
        edited = f.call("get", f"/api/shopping/lists/{f.lists[0]}")["items"]
        assert next(row for row in edited if row["id"] == flour["id"])["recipe_sources"][0] == origin


def test_free_unmeasured_units_and_target_separation():
    with fixture() as f:
        source = create_recipe(f)
        item(f, "Water", 10, "ml")
        item(f, "Flour", 10, "g", note="Different preparation")
        first = transfer(f, source, request(f, keys=("flour", "milk", "salt", "pepper", "spoon")))
        assert (first["created_count"], first["merged_count"]) == (5, 0)
        second = transfer(f, source, request(f, keys=("flour", "milk", "salt", "pepper", "spoon"), cmi="again"))
        assert (second["created_count"], second["merged_count"]) == (2, 3)
        salts = [row for row in second["shopping_list"]["items"] if row["name"] == "Salt"]
        assert len(salts) == 2 and all(row["quantity_text"] == "to taste" and row["quantity_value"] is None for row in salts)
        assert all(row["note"] == "Keep dry" for row in salts)
        assert len([row for row in second["shopping_list"]["items"] if row["name"] == "Pepper"]) == 2
        water = [row for row in second["shopping_list"]["items"] if row["name"] == "Water"]
        assert {(row["quantity_unit"], row["quantity_value"]) for row in water} == {("ml", 10), ("tsp", 4)}
        data = request(f, keys=("milk",), cmi="different-route")
        data["ingredients"][0].update(section_id=None, store_ids=[])
        assert transfer(f, source, data)["created_count"] == 1
        assert convert_quantity(Decimal(1000), "mg", "g") == 1
        assert convert_quantity(Decimal(1), "kg", "g") == 1000
        assert convert_quantity(Decimal(1), "cl", "ml") == 10
        assert convert_quantity(Decimal(1), "dl", "l") == Decimal("0.1")
        for left, right in (("g", "ml"), ("TL", "ml"), ("EL", "TL"), ("ML", "ml"), (None, "g")):
            assert convert_quantity(Decimal(1), left, right) is None
        assert convert_quantity(Decimal(2), None, None) == 2
        assert convert_quantity(Decimal(2), "Stück", "Stück") == 2


def test_exact_storage_provenance_repeated_merge_and_display_mode():
    with fixture() as f:
        payload = recipe_payload()
        payload["base_servings"] = 6
        payload["ingredient_groups"][0]["ingredients"][1]["quantity_value"] = 250
        source = create_recipe(f, payload)
        original = f.call("get", f"/api/recipes/recipes/{source['id']}")
        created = transfer(f, source, request(f, keys=("milk",), servings=2))
        row = created["shopping_list"]["items"][0]
        contribution = float(Decimal(250) / 3)
        assert (row["quantity_value"], row["quantity_unit"], row["quantity_display_mode"]) == (contribution, "ml", "kitchen")
        assert (row["recipe_sources"][0]["quantity_value"], row["recipe_sources"][0]["quantity_unit"]) == (contribution, "ml")
        f.call("delete", f"/api/shopping/items/{row['id']}")
        existing = item(f, "Milk", .5, "l")
        assert existing["quantity_display_mode"] == "exact"
        first = transfer(f, source, request(f, keys=("milk",), servings=2, cmi="merge-rounded-1"))
        row = next(row for row in first["shopping_list"]["items"] if row["id"] == existing["id"])
        first_total = float(Decimal(".5") + Decimal(250) / 3 / 1000)
        assert (row["quantity_value"], row["quantity_unit"], row["quantity_display_mode"]) == (first_total, "l", "kitchen")
        second = transfer(f, source, request(f, keys=("milk",), servings=2, cmi="merge-rounded-2"))
        row = next(row for row in second["shopping_list"]["items"] if row["id"] == existing["id"])
        second_total = float(Decimal(str(first_total)) + Decimal(250) / 3 / 1000)
        assert (row["quantity_value"], row["quantity_unit"]) == (second_total, "l")
        assert [(source["quantity_value"], source["quantity_unit"]) for source in row["recipe_sources"]] == [(contribution, "ml"), (contribution, "ml")]
        assert f.call("get", f"/api/recipes/recipes/{source['id']}") == original
        # Non-quantity changes retain kitchen presentation, including clients
        # that try to send the read-only presentation flag themselves.
        for changes in ({"name": "Milk", "quantity_display_mode": "exact"}, {"completed": False},
                        {"section_id": f.sections[0], "store_ids": [f.stores[0]]}, {"note": ""}):
            updated = f.call("patch", f"/api/shopping/items/{existing['id']}", json=changes)
            assert updated["quantity_display_mode"] == "kitchen"
        updated = f.call("patch", f"/api/shopping/items/{existing['id']}", json={"quantity_value": .123456789, "quantity_unit": "l"})
        assert updated["quantity_display_mode"] == "exact"
        third = transfer(f, source, request(f, keys=("milk",), servings=2, cmi="merge-rounded-3"))
        row = next(row for row in third["shopping_list"]["items"] if row["id"] == existing["id"])
        third_total = float(Decimal(".123456789") + Decimal(250) / 3 / 1000)
        assert (row["quantity_value"], row["quantity_unit"], row["quantity_display_mode"]) == (third_total, "l", "kitchen")
        updated = f.call("patch", f"/api/shopping/items/{existing['id']}", json={"quantity_unit": "Liter"})
        assert updated["quantity_display_mode"] == "exact" and updated["quantity_unit"] == "l"
        # A free quantity, including an explicit clear, is manual as well.
        with get_db() as db:
            db.execute("UPDATE shopping_items SET quantity_display_mode = 'kitchen' WHERE id = ?", (existing["id"],))
        updated = f.call("patch", f"/api/shopping/items/{existing['id']}", json={"quantity_text": None})
        assert updated["quantity_display_mode"] == "exact"
        # Multiplication before division retains an exact half gram, rather
        # than changing its unit after an intermediate repeating fraction.
        half_payload = recipe_payload("exact-half-source")
        half_payload["base_servings"] = 3
        half_payload["ingredient_groups"][0]["ingredients"][0].update(name="Exact half", quantity_value=1.5, quantity_unit="g")
        half_source = create_recipe(f, half_payload)
        half = transfer(f, half_source, request(f, keys=("flour",), servings=1, cmi="exact-half"))
        row = next(row for row in half["shopping_list"]["items"] if row["name"] == "Exact half")
        assert (row["quantity_value"], row["quantity_unit"]) == (.5, "g")
        unknown_payload = recipe_payload("unknown-unit-source")
        unknown_payload["ingredient_groups"][0]["ingredients"][0].update(name="Unknown unit", quantity_value=.25, quantity_unit="Custom measure")
        unknown_source = create_recipe(f, unknown_payload)
        unknown = transfer(f, unknown_source, request(f, keys=("flour",), servings=4, cmi="unknown-unit"))
        row = next(row for row in unknown["shopping_list"]["items"] if row["name"] == "Unknown unit")
        assert (row["quantity_value"], row["quantity_unit"], row["quantity_display_mode"]) == (.25, "Custom measure", "kitchen")
        assert row["recipe_sources"][0]["quantity_value"] == .25


def test_legacy_unit_projections_and_readonly_display_mode():
    with fixture() as f:
        source = create_recipe(f)
        manual = f.call("post", f"/api/shopping/lists/{f.lists[0]}/items", json={
            "name": "Legacy unit", "quantity_value": .25, "quantity_unit": "Liter",
            "quantity_display_mode": "kitchen",
        })
        assert manual["quantity_display_mode"] == "exact"
        # Legacy aliases are canonicalized for all projections without any
        # read-side migration or modification of old source records.
        with get_db() as db:
            db.execute("UPDATE recipe_ingredients SET quantity_unit = 'Liter' WHERE recipe_id = ? AND client_key = 'milk'", (source["id"],))
            db.execute("UPDATE shopping_items SET quantity_unit = 'Liter' WHERE id = ?", (manual["id"],))
        recipe = f.call("get", f"/api/recipes/recipes/{source['id']}")
        milk = next(row for group in recipe["ingredient_groups"] for row in group["ingredients"] if row["client_key"] == "milk")
        assert milk["quantity_unit"] == "l"
        listing = f.call("get", f"/api/shopping/lists/{f.lists[0]}")
        assert listing["items"][0]["quantity_unit"] == "l"
        with get_db() as db:
            assert db.execute("SELECT quantity_unit FROM shopping_items WHERE id = ?", (manual["id"],)).fetchone()[0] == "Liter"
            assert db.execute("SELECT quantity_unit FROM recipe_ingredients WHERE recipe_id = ? AND client_key = 'milk'", (source["id"],)).fetchone()[0] == "Liter"
        updated = f.call("patch", f"/api/shopping/items/{manual['id']}", json={"quantity_display_mode": "kitchen", "name": "Still manual"})
        assert updated["quantity_display_mode"] == "exact" and updated["quantity_value"] == .25
        with get_db() as db:
            try:
                db.execute("UPDATE shopping_items SET quantity_display_mode = 'invalid' WHERE id = ?", (manual["id"],))
            except sqlite3.IntegrityError:
                pass
            else:
                raise AssertionError("Display mode CHECK must reject invalid persisted values")


def test_idempotency_source_edits_deletion_and_revocation():
    with fixture() as f:
        source = create_recipe(f)
        payload = request(f)
        f.actor["id"] = f.users[1]
        first = transfer(f, source, payload)
        before = counts()
        assert transfer(f, source, payload) == first
        assert counts() == before
        reused = copy.deepcopy(payload); reused["servings"] = 4
        assert transfer(f, source, reused, 409)["detail"]["code"] == "recipe.transferMutationReused"
        f.actor["id"] = f.users[0]
        current = f.call("patch", f"/api/recipes/recipes/{source['id']}", json={"client_mutation_id": "source-edit", "expected_revision": 1, "title": "Changed"})
        f.actor["id"] = f.users[1]
        assert transfer(f, source, payload)["source_revision"] == 1
        transfer(f, source, request(f, cmi="outdated"), 409)
        with get_db() as db:
            remove_entity_access(db, "cookbook", f.book, f.users[0], f.users[1])
        transfer(f, source, request(f, cmi="no-source", revision=2), 404)
        assert transfer(f, source, payload)["created_count"] == first["created_count"]
        f.actor["id"] = f.users[0]
        f.call("delete", f"/api/recipes/recipes/{source['id']}?expected_revision={current['revision']}&client_mutation_id=delete-source")
        f.actor["id"] = f.users[1]
        assert transfer(f, source, payload)["source_revision"] == 1
        assert counts() == before
        with get_db() as db:
            remove_entity_access(db, "shopping_list", f.lists[0], f.users[0], f.users[1])
        transfer(f, source, payload, 404)
        assert counts() == before


def test_source_receipts_pending_revision_and_privacy():
    with fixture() as f:
        source = create_recipe(f)
        payload = request(f, revision=0)
        payload["source_mutation_id"] = "source-create"
        transfer(f, source, payload)
        edited = f.call("patch", f"/api/recipes/recipes/{source['id']}", json={"client_mutation_id": "source-edit", "expected_revision": 1, "description": "new"})
        stale = request(f, cmi="stale-receipt", revision=0); stale["source_mutation_id"] = "source-create"
        transfer(f, source, stale, 409)
        latest = request(f, cmi="new-receipt", revision=0); latest["source_mutation_id"] = "source-edit"
        assert transfer(f, source, latest)["source_revision"] == edited["revision"]
        missing = request(f, cmi="unknown-receipt", revision=0); missing["source_mutation_id"] = "not-applied"
        transfer(f, source, missing, 409)
        f.actor["id"] = f.users[1]
        not_own = request(f, cmi="foreign-actor-receipt", revision=0); not_own["source_mutation_id"] = "source-edit"
        transfer(f, source, not_own, 409)
        f.actor["id"] = f.users[4]
        view = f.call("get", f"/api/shopping/lists/{f.lists[0]}")
        assert all(origin["recipe_id"] is None for row in view["items"] for origin in row["recipe_sources"])
        assert all(origin["recipe_title"] == source["title"] for row in view["items"] for origin in row["recipe_sources"])
        with get_db() as db:
            grant_entity_access(db, "cookbook", f.book, f.users[0], f.users[4])
        visible = f.call("get", f"/api/shopping/lists/{f.lists[0]}")
        assert all(origin["recipe_id"] == source["id"] for row in visible["items"] for origin in row["recipe_sources"])
        with get_db() as db:
            remove_entity_access(db, "cookbook", f.book, f.users[0], f.users[4])
        hidden = f.call("get", f"/api/shopping/lists/{f.lists[0]}")
        assert all(origin["recipe_id"] is None for row in hidden["items"] for origin in row["recipe_sources"])


def test_scoped_targets_pending_grants_and_household_content():
    with fixture() as f:
        source = create_recipe(f)
        before = counts()
        for field, value in (("section_id", f.sections[1]), ("store_ids", [f.stores[1]])):
            data = request(f); data["ingredients"][0][field] = value
            transfer(f, source, data, 400)
            assert counts() == before
        with get_db() as db:
            db.execute("UPDATE shopping_stores SET active=0 WHERE id=?", (f.stores[0],))
        transfer(f, source, request(f), 400)
        with get_db() as db:
            db.execute("UPDATE shopping_stores SET active=1 WHERE id=?", (f.stores[0],))
        bad_key = request(f); bad_key["ingredients"].append({"ingredient_client_key": "foreign-recipe-key"})
        transfer(f, source, bad_key, 422)
        assert counts() == before
        f.actor["id"] = f.users[2]
        transfer(f, source, request(f), 404)
        f.actor["id"] = f.users[3]
        private_source = request(f); private_source["shopping_list_id"] = f.lists[1]
        transfer(f, source, private_source, 404)
        f.actor["id"] = f.users[1]
        assert transfer(f, source)["shopping_list"]["can_manage"] is False
        f.actor["id"] = f.users[0]
        with get_db() as db:
            household = create_household(db, "Family", f.users[0])
            invitation = invite_household_member(db, household, f.users[0], f.users[1])
            respond_to_household_invite(db, invitation, f.users[1], accept=True)
            household_list = db.execute("INSERT INTO shopping_lists (name) VALUES ('Family list')").lastrowid
            register_household_entity(db, "shopping_list", household_list, f.users[0], household)
        f.actor["id"] = f.users[1]
        household_payload = request(f, cmi="family")
        household_payload["shopping_list_id"] = household_list
        for row in household_payload["ingredients"]: row.update(section_id=None, store_ids=[])
        result = transfer(f, source, household_payload)
        assert result["shopping_list"]["ownership_type"] == "household" and not result["shopping_list"]["can_manage"]


def test_generic_amount_validation_zero_nonfinite_and_bounds():
    with fixture() as f:
        source = create_recipe(f)
        zero = item(f, "Flour", 0, "kg", note="Sifted")
        assert transfer(f, source, request(f, keys=("flour",)))["shopping_list"]["items"][0]["quantity_value"] == .5
        f.call("patch", f"/api/shopping/items/{zero['id']}", 422, json={"quantity_text": "a little"})
        free = f.call("patch", f"/api/shopping/items/{zero['id']}", json={"quantity_value": None, "quantity_text": "<1 spoon>", "note": "Literal <text>"})
        assert free["quantity_text"] == "<1 spoon>" and free["note"] == "Literal <text>"
        f.call("patch", f"/api/shopping/items/{zero['id']}", 422, json={"quantity_value": 1})
        numeric = f.call("patch", f"/api/shopping/items/{zero['id']}", json={"quantity_value": 0, "quantity_text": None})
        assert numeric["quantity_value"] == 0 and numeric["quantity_text"] is None
        for changes in ({"servings": 0}, {"servings": -1}, {"servings": True}, {"expected_revision": 0}, {"ingredients": []}):
            data = request(f, cmi="invalid"); data.update(changes)
            transfer(f, source, data, 422)
        duplicate = request(f); duplicate["ingredients"].append(copy.deepcopy(duplicate["ingredients"][0]))
        transfer(f, source, duplicate, 422)
        injected = request(f); injected["ingredients"][0]["quantity_value"] = 100
        transfer(f, source, injected, 422)
        for raw in ("NaN", "Infinity", "-Infinity"):
            body = '{"shopping_list_id":%d,"servings":%s,"expected_revision":1,"client_mutation_id":"nonfinite","ingredients":[{"ingredient_client_key":"flour"}]}' % (f.lists[0], raw)
            f.call("post", f"/api/recipes/recipes/{source['id']}/shopping-transfer", 422, content=body, headers={"Content-Type": "application/json"})
        enormous = recipe_payload("huge-source"); enormous["ingredient_groups"][0]["ingredients"][0]["quantity_value"] = 1e308
        huge = create_recipe(f, enormous)
        before = counts(); transfer(f, huge, request(f, cmi="scaled-overflow", keys=("flour",), servings=100000), 422)
        assert counts() == before
        tiny = recipe_payload("tiny-source")
        tiny["base_servings"] = 100000
        tiny["ingredient_groups"][0]["ingredients"][0]["quantity_value"] = 1e-300
        tiny_source = create_recipe(f, tiny)
        before = counts()
        transfer(f, tiny_source, request(f, cmi="scaled-underflow", keys=("flour",), servings=1e-20), 422)
        assert counts() == before


def equivalent_flour_payload(cmi="equivalent-source", notes=("Sifted", "For topping")):
    data = recipe_payload(cmi)
    data["ingredient_groups"][0]["ingredients"][0]["note"] = notes[0]
    data["ingredient_groups"].append({"client_key": "topping", "name": "Topping", "ingredients": [
        {"client_key": "flour-topping", "name": " FLOUR ", "quantity_value": .05, "quantity_unit": "kg", "note": notes[1]}]})
    data["steps"] = [{"client_key": "mix", "text": "Use a portion, then reuse the prepared flour.",
                      "ingredients": [{"ingredient_client_key": "flour", "quantity_value": 10}]}]
    return data


def grouped_request(f, cmi="grouped-transfer"):
    data = request(f, keys=("flour", "flour-topping"), servings=4, cmi=cmi)
    for ingredient in data["ingredients"]:
        ingredient["merge_group"] = "same-flour"
    return data


def test_explicit_equivalence_preserves_source_notes_totals_and_receipts():
    with fixture() as f:
        source = create_recipe(f, equivalent_flour_payload())
        original = f.call("get", f"/api/recipes/recipes/{source['id']}")
        first_note = item(f, "Flour", 1, "kg", note="Sifted")
        other_note = item(f, "Flour", 2, "kg", note="For topping")
        completed = item(f, "Flour", 3, "kg", note="Sifted\nFor topping")
        f.call("patch", f"/api/shopping/items/{completed['id']}", json={"completed": True})
        data = grouped_request(f)
        first = transfer(f, source, data)
        assert (first["created_count"], first["merged_count"]) == (1, 1)
        rows = {row["id"]: row for row in first["shopping_list"]["items"]}
        assert rows[first_note["id"]]["quantity_value"] == 1
        assert rows[other_note["id"]]["quantity_value"] == 2
        assert rows[completed["id"]]["quantity_value"] == 3 and rows[completed["id"]]["completed"]
        grouped = next(row for row in rows.values() if row["id"] not in (first_note["id"], other_note["id"], completed["id"]))
        assert (grouped["quantity_value"], grouped["quantity_unit"], grouped["note"]) == (300, "g", "Sifted\nFor topping")
        assert [(row["ingredient_client_key"], row["quantity_value"], row["quantity_unit"], row["note"]) for row in grouped["recipe_sources"]] == [
            ("flour", 250, "g", "Sifted"), ("flour-topping", .05, "kg", "For topping")]
        before = counts()
        assert transfer(f, source, data) == first and counts() == before
        reused = copy.deepcopy(data); reused["ingredients"][0]["merge_group"] = "different-group"
        assert transfer(f, source, reused, 409)["detail"]["code"] == "recipe.transferMutationReused"
        second = transfer(f, source, grouped_request(f, "second-grouped-transfer"))
        same = next(row for row in second["shopping_list"]["items"] if row["id"] == grouped["id"])
        assert same["quantity_value"] == 600 and same["recipe_sources_count"] == 4
        assert (second["created_count"], second["merged_count"]) == (0, 2)
        # Omitting the explicit capability keeps the pre-existing exact-note
        # behavior; it does not conflate different recipe components by name.
        ungrouped = transfer(f, source, request(f, keys=("flour", "flour-topping"), servings=4, cmi="ungrouped-notes"))
        rows = {row["id"]: row for row in ungrouped["shopping_list"]["items"]}
        assert rows[first_note["id"]]["quantity_value"] == 1.25
        assert rows[other_note["id"]]["quantity_value"] == 2.05
        assert rows[grouped["id"]]["quantity_value"] == 600
        assert f.call("get", f"/api/recipes/recipes/{source['id']}") == original


def test_group_validation_authorization_and_long_note_isolation():
    with fixture() as f:
        source = create_recipe(f, equivalent_flour_payload())
        for value in ("", " ", "x" * 201, 1):
            invalid = grouped_request(f)
            invalid["ingredients"][0]["merge_group"] = value
            transfer(f, source, invalid, 422)
        before = counts()
        invalid = grouped_request(f)
        invalid["ingredients"][1]["section_id"] = None
        transfer(f, source, invalid, 422)
        invalid = grouped_request(f)
        invalid["ingredients"][1]["store_ids"] = []
        transfer(f, source, invalid, 422)
        invalid = grouped_request(f)
        invalid["ingredients"][1]["store_ids"] = [f.stores[1]]
        transfer(f, source, invalid, 400)
        for field, value in (("name", "Different ingredient"), ("quantity_unit", "ml"), ("quantity_value", None)):
            data = equivalent_flour_payload("bad-equivalence-" + field)
            data["ingredient_groups"][1]["ingredients"][0][field] = value
            bad_source = create_recipe(f, data)
            transfer(f, bad_source, grouped_request(f), 422)
        assert counts() == before
        f.actor["id"] = f.users[2]
        transfer(f, source, grouped_request(f), 404)
        f.actor["id"] = f.users[0]
        notes = ("a" * 1500, "b" * 1500)
        long_source = create_recipe(f, equivalent_flour_payload("long-group-notes", notes))
        truncated = (notes[0] + "\n" + notes[1])[:1999] + "…"
        existing = item(f, "Flour", 1, "kg", note=truncated)
        result = transfer(f, long_source, grouped_request(f, "long-note-group"))
        assert (result["created_count"], result["merged_count"]) == (1, 1)
        untouched = next(row for row in result["shopping_list"]["items"] if row["id"] == existing["id"])
        new = next(row for row in result["shopping_list"]["items"] if row["id"] != existing["id"])
        assert untouched["quantity_value"] == 1 and untouched["recipe_sources_count"] == 0
        assert new["quantity_value"] == 300 and new["note"] == truncated and len(new["note"]) == 2000
        assert [row["note"] for row in new["recipe_sources"]] == list(notes)


def test_legacy_receipt_fingerprint_survives_optional_merge_capability():
    with fixture() as f:
        source = create_recipe(f)
        data = request(f, cmi="pre66-receipt")
        first = transfer(f, source, data)
        old_contract = transfers.RecipeShoppingTransfer(**data).model_dump()
        for ingredient in old_contract["ingredients"]:
            del ingredient["merge_group"]
        old_hash = hashlib.sha256(json.dumps({"recipe_id": source["id"], **old_contract}, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()).hexdigest()
        with get_db() as db:
            db.execute("UPDATE recipe_shopping_transfers SET request_hash = ? WHERE client_mutation_id = ?", (old_hash, data["client_mutation_id"]))
        before = counts()
        assert transfer(f, source, data) == first and counts() == before


def test_grouped_transfer_rollback_is_atomic():
    with fixture() as f:
        source = create_recipe(f, equivalent_flour_payload())
        data = grouped_request(f)
        data["ingredients"].append({"ingredient_client_key": "salt", "section_id": f.sections[0], "store_ids": [f.stores[0]]})
        real_insert = transfers.insert_shopping_item
        def insert_or_fail(*args, **kwargs):
            if kwargs.get("name") == "Salt":
                raise RuntimeError("forced failure after grouped create and merge")
            return real_insert(*args, **kwargs)
        with patch.object(transfers, "insert_shopping_item", side_effect=insert_or_fail):
            transfer(f, source, data, 500)
        assert counts() == (0, 0, 0)


def test_rollback_concurrent_receipts_and_tombstones():
    with fixture() as f:
        source = create_recipe(f)
        existing = item(f, "Flour", 1, "kg", note="Sifted")
        before = counts()
        with patch.object(transfers, "insert_shopping_item", side_effect=RuntimeError("forced insert failure")):
            transfer(f, source, request(f, keys=("flour", "salt")), 500)
        assert counts() == before
        assert f.call("get", f"/api/shopping/lists/{f.lists[0]}")["items"][0]["quantity_value"] == 1
        payload = transfers.RecipeShoppingTransfer(**request(f, keys=("flour",), cmi="concurrent"))
        def apply():
            return asyncio.run(recipes.transfer_recipe_to_shopping(source["id"], payload, f.users[0]))
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda _: apply(), range(2)))
        assert responses[0] == responses[1]
        assert responses[0]["shopping_list"]["items"][0]["quantity_value"] == 1.5
        assert counts() == (1, 1, 1)
        f.call("delete", f"/api/shopping/items/{existing['id']}")
        assert counts() == (0, 1, 0)
        replay = transfer(f, source, request(f, keys=("flour",), cmi="concurrent"))
        assert replay["shopping_list"]["items"] == [] and counts() == (0, 1, 0)
        with get_db() as db:
            assert db.execute("PRAGMA foreign_key_check").fetchall() == []


def main():
    tests = [value for name, value in globals().items() if name.startswith("test_") and callable(value)]
    try:
        for test in tests:
            test()
            print("✅", test.__name__)
        print(f"Recipe Shopping transfer: {len(tests)} isolated groups passed")
    finally:
        TEST_ROOT.cleanup()


if __name__ == "__main__":
    main()
