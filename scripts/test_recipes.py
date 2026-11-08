#!/usr/bin/env python3
"""Recipe aggregate invariants on exclusively disposable SQLite databases."""

import asyncio
import base64
import contextlib
import copy
import io
import os
import sqlite3
import sys
import tempfile
import threading
from dataclasses import replace
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import ValidationError

ROOT = Path(__file__).resolve().parents[1]
TEST_ROOT = tempfile.TemporaryDirectory(prefix="nia-recipes-tests-")
os.environ["NIA_TODO_DATA_DIR"] = TEST_ROOT.name
sys.path.insert(0, str(ROOT / "api"))
import db as database
import migrate
from db import get_db
from routers import recipes
from routers.auth import require_auth
from services.entity_access import invite_entity_access, register_personal_entity, respond_to_entity_invite
from services import recipe_content
from services.recipe_content import RecipeCreate, RecipePatch
from services.recipes import get_sync_cookbooks


@contextlib.contextmanager
def fixture():
    with tempfile.TemporaryDirectory(dir=TEST_ROOT.name) as directory:
        path = Path(directory) / "recipes.db"
        with patch.object(database, "DB_PATH", path), patch.object(migrate, "DB_PATH", path), patch.object(recipes, "broadcast_sync_to_users", AsyncMock()) as broadcasts:
            with contextlib.redirect_stdout(io.StringIO()):
                migrate.run_migrations()
            with get_db() as db:
                users = [db.execute("INSERT INTO users (username) VALUES (?)", (f"recipe-user-{n}",)).lastrowid for n in range(4)]
                books = [db.execute("INSERT INTO cookbooks (name, created_by_user_id) VALUES (?, ?)", (f"Book {n}", users[0] if n == 0 else users[3])).lastrowid for n in range(2)]
                for index, book in enumerate(books):
                    register_personal_entity(db, "cookbook", book, users[0] if index == 0 else users[3])
                invite = invite_entity_access(db, "cookbook", books[0], users[0], users[1])
                respond_to_entity_invite(db, "cookbook", books[0], invite["id"], users[1], accept=True)
                invite_entity_access(db, "cookbook", books[0], users[0], users[2])
            actor = {"id": users[0]}
            app = FastAPI()
            app.include_router(recipes.router)
            app.dependency_overrides[require_auth] = lambda: actor["id"]
            with TestClient(app) as client:
                def call(method, endpoint, expected=200, **kwargs):
                    response = getattr(client, method)(endpoint, **kwargs)
                    assert response.status_code == expected, (method, endpoint, response.status_code, response.text)
                    return response.json()
                yield SimpleNamespace(users=users, books=books, actor=actor, client=client, call=call, broadcasts=broadcasts)


def payload(cmi="create-1"):
    return {"client_mutation_id": cmi, "title": "Pasta", "description": "A weeknight meal", "base_servings": 4,
            "prep_minutes": 10, "cook_minutes": 0, "tags": ["Quick", " quick ", "Family"],
            "ingredient_groups": [
                {"client_key": "main", "name": "Pasta", "ingredients": [{"client_key": "flour", "name": "Flour", "quantity_value": 250, "quantity_unit": "grams", "note": "Sifted"}]},
                {"client_key": "sauce", "name": "Sauce", "ingredients": [{"client_key": "salt", "name": "Salt", "quantity_text": "to taste"}]}],
            "steps": [
                {"client_key": "mix", "text": "Mix well.\nKeep this in one step.", "ingredients": [
                    {"ingredient_client_key": "flour"}, {"ingredient_client_key": "salt", "show_quantity": False}]},
                {"client_key": "cook", "text": "Cook.", "ingredients": [{"ingredient_client_key": "salt"}]}]}


def create(f, data=None):
    return f.call("post", f"/api/recipes/cookbooks/{f.books[0]}/recipes", json=data or payload())


def png_data():
    output = io.BytesIO()
    Image.new("RGB", (16, 16), "green").save(output, format="PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()


def test_aggregate_crud_preserves_stable_children_and_order():
    with fixture() as f:
        first = create(f)
        path = f"/api/recipes/recipes/{first['id']}"
        assert first["revision"] == first["applied_revision"] == 1 and first["can_edit"]
        assert first["tags"] == ["Quick", "Family"] and first["cook_minutes"] == 0
        assert first["ingredient_groups"][0]["ingredients"][0]["quantity_unit"] == "g"
        assert "\n" in first["steps"][0]["text"] and len(first["steps"]) == 2
        flour_id = first["ingredient_groups"][0]["ingredients"][0]["id"]
        groups = copy.deepcopy(first["ingredient_groups"])
        groups[1]["ingredients"].append(groups[0]["ingredients"].pop())
        groups.reverse()
        revised = f.call("patch", path, json={"expected_revision": 1, "client_mutation_id": "edit-1", "ingredient_groups": groups, "steps": list(reversed(first["steps"])), "tags": ["Edited"]})
        assert revised["revision"] == revised["applied_revision"] == 2
        assert revised["ingredient_groups"][0]["id"] == first["ingredient_groups"][1]["id"]
        assert revised["ingredient_groups"][0]["ingredients"][1]["id"] == flour_id
        assert revised["steps"][0]["id"] == first["steps"][1]["id"]
        assert revised["tags"] == ["Edited"]
        assert f.call("get", path)["description"] == first["description"]
        book = f.call("get", f"/api/recipes/cookbooks/{f.books[0]}")
        assert book["recipe_count"] == 1 and book["recipes"][0]["id"] == first["id"]
        emptied = f.call("patch", path, json={"expected_revision": 2, "client_mutation_id": "clear-children", "ingredient_groups": [], "steps": [], "tags": []})
        assert emptied["ingredient_groups"] == emptied["steps"] == emptied["tags"] == []


def test_validation_bounds_duplicates_quantities_and_drafts():
    with fixture() as f:
        invalid = [{"title": " "}, {"base_servings": 0}, {"base_servings": True}, {"base_servings": 100001}, {"prep_minutes": -1}, {"prep_minutes": True}, {"cook_minutes": 1.5},
                   {"tags": [" "]}, {"tags": ["x"] * 41}, {"description": "x" * 4001}, {"steps": [{"client_key": "s", "text": " "}]}]
        for changes in invalid:
            f.call("post", f"/api/recipes/cookbooks/{f.books[0]}/recipes", expected=422, json={**payload(), **changes})
        for amount in ({"quantity_value": 0}, {"quantity_value": True}, {"quantity_value": -1}, {"quantity_value": 1, "quantity_text": "to taste"}):
            data = payload()
            data["ingredient_groups"][0]["ingredients"][0].update(amount)
            f.call("post", f"/api/recipes/cookbooks/{f.books[0]}/recipes", expected=422, json=data)
        duplicate = payload()
        duplicate["ingredient_groups"][1]["ingredients"][0]["client_key"] = "flour"
        f.call("post", f"/api/recipes/cookbooks/{f.books[0]}/recipes", expected=422, json=duplicate)
        too_large = {**payload(), "steps": [{"client_key": f"step-{n}", "text": "x" * 8000} for n in range(100)]}
        f.call("post", f"/api/recipes/cookbooks/{f.books[0]}/recipes", expected=422, json=too_large)
        for value in (float("nan"), float("inf"), -float("inf")):
            try:
                RecipeCreate.model_validate({**payload(), "base_servings": value})
            except ValidationError:
                pass
            else:
                raise AssertionError("Nonfinite servings must fail validation")
        draft = create(f, {"title": "Draft", "client_mutation_id": "draft"})
        assert draft["ingredient_groups"] == draft["steps"] == [] and draft["base_servings"] == 1
        for null_field in ("title", "description", "base_servings", "ingredient_groups", "steps", "tags"):
            f.call("patch", f"/api/recipes/recipes/{draft['id']}", expected=422, json={"expected_revision": 1, "client_mutation_id": "null", null_field: None})


def test_step_ingredient_order_legacy_preserve_clear_and_prune():
    with fixture() as f:
        first = create(f)
        path = f"/api/recipes/recipes/{first['id']}"
        assert first["steps"][0]["ingredients"] == [
            {"ingredient_client_key": "flour", "show_quantity": True},
            {"ingredient_client_key": "salt", "show_quantity": False}]
        old_ids = {step["client_key"]: step["id"] for step in first["steps"]}
        legacy_steps = [{"client_key": step["client_key"], "text": step["text"] + " Updated"} for step in reversed(first["steps"])]
        legacy = f.call("patch", path, json={"expected_revision": 1, "client_mutation_id": "legacy-steps", "steps": legacy_steps})
        assert legacy["steps"][0]["ingredients"] == first["steps"][1]["ingredients"]
        assert legacy["steps"][1]["ingredients"] == first["steps"][0]["ingredients"]
        assert all(step["id"] == old_ids[step["client_key"]] for step in legacy["steps"])
        groups = copy.deepcopy(legacy["ingredient_groups"])
        groups[0]["ingredients"][0]["name"] = "Renamed flour"
        renamed = f.call("patch", path, json={"expected_revision": 2, "client_mutation_id": "rename-ingredient", "ingredient_groups": groups})
        assert renamed["steps"] == legacy["steps"]
        groups[0]["ingredients"] = []
        pruned = f.call("patch", path, json={"expected_revision": 3, "client_mutation_id": "remove-ingredient", "ingredient_groups": groups})
        mix = next(step for step in pruned["steps"] if step["client_key"] == "mix")
        assert mix["ingredients"] == [{"ingredient_client_key": "salt", "show_quantity": False}]
        # Missing field preserves the existing cook link; explicit [] clears
        # mix; a new legacy step starts with no ingredient references.
        cleared = f.call("patch", path, json={"expected_revision": 4, "client_mutation_id": "clear-step-links", "steps": [
            {"client_key": "mix", "text": "Now without links", "ingredients": []},
            {"client_key": "cook", "text": "Cook."}, {"client_key": "serve", "text": "Serve."}]})
        assert [step["ingredients"] for step in cleared["steps"]] == [[], first["steps"][1]["ingredients"], []]
        assert cleared["steps"][0]["id"] == old_ids["mix"]
        bad = {"expected_revision": 5, "client_mutation_id": "deleted-explicit-ref", "steps": [
            {"client_key": "mix", "text": "Invalid", "ingredients": [{"ingredient_client_key": "flour"}]}]}
        f.call("patch", path, expected=422, json=bad)
        assert f.call("get", path) == {key: value for key, value in cleared.items() if key != "applied_revision"}
        with get_db() as db:
            assert db.execute("SELECT 1 FROM recipe_mutation_receipts WHERE client_mutation_id = ?", (bad["client_mutation_id"],)).fetchone() is None


def test_step_ingredient_validation_same_effective_recipe_and_size():
    with fixture() as f:
        source = create(f)
        foreign_data = payload("foreign-recipe")
        foreign_data["ingredient_groups"][0]["ingredients"][0]["client_key"] = "foreign-only"
        foreign_data["steps"][0]["ingredients"][0]["ingredient_client_key"] = "foreign-only"
        create(f, foreign_data)
        endpoint = f"/api/recipes/recipes/{source['id']}"
        for key in ("missing", "foreign-only"):
            f.call("patch", endpoint, expected=422, json={"expected_revision": 1, "client_mutation_id": "bad-" + key,
                "title": "Must not change", "steps": [{"client_key": "mix", "text": "Mix", "ingredients": [{"ingredient_client_key": key}]}]})
        for links in (
            [{"ingredient_client_key": "salt"}] * 2,
            [{"ingredient_client_key": "salt"}] * 501,
            [{"ingredient_client_key": " "}], [{"ingredient_client_key": "x" * 201}],
            [{"ingredient_client_key": 1}], [{"ingredient_client_key": "salt", "show_quantity": None}],
            [{"ingredient_client_key": "salt", "quantity_value": 2}],
            *[[{"ingredient_client_key": "salt", "show_quantity": value}] for value in (0, 1, "true", float("nan"), float("inf"))],
        ):
            invalid = payload("invalid-links")
            invalid["steps"][0]["ingredients"] = links
            try:
                RecipeCreate.model_validate(invalid)
            except ValidationError:
                pass
            else:
                raise AssertionError(f"Invalid step ingredients accepted: {links[:2]}")
        invalid = payload("invalid-create-ref")
        invalid["steps"][0]["ingredients"] = [{"ingredient_client_key": "foreign-only"}]
        f.call("post", f"/api/recipes/cookbooks/{f.books[0]}/recipes", expected=422, json=invalid)
        # Explicit bad references must fail even when the same PATCH removes
        # their ingredient. Only omitted/inherited references may be pruned.
        f.call("patch", endpoint, expected=422, json={"expected_revision": 1, "client_mutation_id": "explicit-removed",
            "ingredient_groups": [], "steps": source["steps"]})
        large = payload("links-size")
        ingredient_keys = [f"ingredient-{n}-" + "x" * 180 for n in range(500)]
        large["ingredient_groups"] = [{"client_key": "main", "ingredients": [{"client_key": key, "name": "Ingredient"} for key in ingredient_keys]}]
        large["steps"] = [{"client_key": f"s{n}", "text": "Step", "ingredients": [{"ingredient_client_key": key} for key in ingredient_keys]} for n in range(8)]
        f.call("post", f"/api/recipes/cookbooks/{f.books[0]}/recipes", expected=422, json=large)
        assert f.call("get", endpoint)["revision"] == 1
        with get_db() as db:
            assert db.execute("SELECT COUNT(*) FROM recipes").fetchone()[0] == 2
            assert db.execute("SELECT COUNT(*) FROM recipe_mutation_receipts").fetchone()[0] == 2


def test_step_ingredient_permissions_bounded_projection_and_database_boundaries():
    with fixture() as f:
        first = create(f)
        second = create(f, payload("second-linked-recipe"))
        path = f"/api/recipes/recipes/{first['id']}"
        f.actor["id"] = f.users[1]
        shared = f.call("patch", path, json={"expected_revision": 1, "client_mutation_id": "shared-step-link", "steps": [
            {"client_key": "mix", "text": "Shared step", "ingredients": [{"ingredient_client_key": "salt", "show_quantity": False}]}]})
        assert shared["steps"][0]["ingredients"] == [{"ingredient_client_key": "salt", "show_quantity": False}]
        assert f.call("patch", path, json={"expected_revision": 1, "client_mutation_id": "shared-step-link", "steps": []})["applied_revision"] == 2
        f.call("patch", path, expected=409, json={"expected_revision": 1, "client_mutation_id": "stale-step-link", "steps": []})
        for user in (f.users[2], f.users[3]):
            f.actor["id"] = user
            f.call("get", path, expected=404)
            f.call("patch", path, expected=404, json={"expected_revision": 2, "client_mutation_id": "denied-step-link", "steps": []})
        f.actor["id"] = f.users[0]
        # Current generic grants permit editing. A read-only permission result
        # must still never gain an independent write path through step links.
        from services.entity_access import resolve_entity_access
        with get_db() as db:
            readonly = replace(resolve_entity_access(db, "cookbook", f.books[0], f.users[0]), can_edit_content=False)
        with patch.object(recipe_content, "resolve_entity_access", return_value=readonly), patch.object(recipes, "resolve_entity_access", return_value=readonly):
            assert not f.call("get", path)["can_edit"]
            f.call("patch", path, expected=404, json={"expected_revision": 2, "client_mutation_id": "readonly-step-link", "steps": []})
        with get_db() as db:
            queries = []
            db.set_trace_callback(queries.append)
            books = get_sync_cookbooks(db, f.users[0])
            db.set_trace_callback(None)
            assert len(books[0]["recipes"]) == 2
            assert sum("FROM recipe_step_ingredients link" in query for query in queries) == 1
            foreign_step = second["steps"][0]["id"]
            foreign_ingredient = second["ingredient_groups"][0]["ingredients"][0]["id"]
            own_step = shared["steps"][0]["id"]
            own_ingredient = first["ingredient_groups"][0]["ingredients"][0]["id"]
            for step_id, ingredient_id, show_quantity in ((foreign_step, own_ingredient, 1), (own_step, foreign_ingredient, 1), (own_step, own_ingredient, 2)):
                db.execute("SAVEPOINT invalid_step_link")
                try:
                    db.execute("INSERT INTO recipe_step_ingredients(recipe_id,step_id,ingredient_id,show_quantity,sort_order) VALUES (?,?,?,?,0)", (first["id"], step_id, ingredient_id, show_quantity))
                except sqlite3.IntegrityError:
                    pass
                else:
                    raise AssertionError("Step link database boundary accepted an invalid reference/flag")
                finally:
                    db.execute("ROLLBACK TO invalid_step_link")
                    db.execute("RELEASE invalid_step_link")
            db.execute("DELETE FROM recipe_steps WHERE id = ?", (own_step,))
            assert db.execute("SELECT 1 FROM recipe_step_ingredients WHERE recipe_id = ?", (first["id"],)).fetchone() is None
            db.execute("DELETE FROM recipe_ingredients WHERE id = ?", (foreign_ingredient,))
            assert db.execute("SELECT 1 FROM recipe_step_ingredients WHERE ingredient_id = ?", (foreign_ingredient,)).fetchone() is None
            assert db.execute("PRAGMA foreign_key_check").fetchall() == []


def test_step_ingredient_receipt_failure_rolls_back_and_recipe_delete_cascades():
    with fixture() as f:
        first = create(f)
        path = f"/api/recipes/recipes/{first['id']}"
        before = f.call("get", path)
        update = RecipePatch.model_validate({"expected_revision": 1, "client_mutation_id": "rollback-links", "steps": [
            {"client_key": "mix", "text": "Must roll back", "ingredients": []}]})
        with patch.object(recipes, "_record_recipe_receipt", side_effect=RuntimeError("forced step-link receipt failure")):
            try:
                asyncio.run(recipes.update_recipe(first["id"], update, f.users[0]))
            except RuntimeError:
                pass
            else:
                raise AssertionError("Step links and aggregate must roll back with failed receipt")
        assert f.call("get", path) == before
        with get_db() as db:
            assert db.execute("SELECT COUNT(*) FROM recipe_step_ingredients WHERE recipe_id = ?", (first["id"],)).fetchone()[0] == 3
            assert db.execute("SELECT 1 FROM recipe_mutation_receipts WHERE client_mutation_id = 'rollback-links'").fetchone() is None
        f.call("delete", path, params={"expected_revision": 1, "client_mutation_id": "delete-linked-recipe"})
        with get_db() as db:
            assert db.execute("SELECT 1 FROM recipe_step_ingredients WHERE recipe_id = ?", (first["id"],)).fetchone() is None
            assert db.execute("PRAGMA foreign_key_check").fetchall() == []


def test_cookbook_content_permissions_and_revocation():
    with fixture() as f:
        recipe = create(f)
        path = f"/api/recipes/recipes/{recipe['id']}"
        f.actor["id"] = f.users[1]
        assert f.call("get", path)["can_edit"]
        f.call("patch", f"/api/recipes/cookbooks/{f.books[0]}", expected=404, json={"name": "Metadata denied"})
        assert f.call("patch", path, json={"expected_revision": 1, "client_mutation_id": "member-edit", "title": "Shared edit"})["revision"] == 2
        member_recipe = create(f, payload("member-create"))
        assert member_recipe["created_by_user_id"] == f.users[1]
        f.call("delete", f"/api/recipes/recipes/{member_recipe['id']}", params={"expected_revision": 1, "client_mutation_id": "member-delete"})
        for user in (f.users[2], f.users[3]):
            f.actor["id"] = user
            f.call("get", path, expected=404)
            result = f.call("patch", path, expected=404, json={"expected_revision": 1, "client_mutation_id": "denied", "title": "No"})
            assert "current" not in str(result)
        with get_db() as db:
            db.execute("UPDATE entity_access_grants SET status = 'removed' WHERE user_id = ?", (f.users[1],))
        f.actor["id"] = f.users[1]
        f.call("patch", path, expected=404, json={"expected_revision": 1, "client_mutation_id": "member-edit", "title": "Shared edit"})
        with get_db() as db:
            assert get_sync_cookbooks(db, f.users[1]) == []


def test_receipt_applied_revision_conflicts_and_delete_tombstones():
    with fixture() as f:
        recipe = create(f)
        path = f"/api/recipes/recipes/{recipe['id']}"
        edit = {"expected_revision": 1, "client_mutation_id": "own-edit", "title": "My edit"}
        f.call("patch", path, json=edit)
        replay_create = create(f)
        assert replay_create["revision"] == 2 and replay_create["applied_revision"] == 1
        f.actor["id"] = f.users[1]
        f.call("patch", path, json={"expected_revision": 2, "client_mutation_id": "foreign-edit", "description": "Foreign update"})
        f.actor["id"] = f.users[0]
        replay_edit = f.call("patch", path, json=edit)
        assert replay_edit["revision"] == 3 and replay_edit["applied_revision"] == 2
        conflict = f.call("patch", path, expected=409, json={"expected_revision": 2, "client_mutation_id": "next-own-edit", "description": "Do not overwrite foreign edit"})
        assert conflict["detail"]["code"] == "recipe.revisionConflict" and conflict["detail"]["current"]["revision"] == 3
        with get_db() as db:
            assert db.execute("SELECT 1 FROM recipe_mutation_receipts WHERE client_mutation_id = 'next-own-edit'").fetchone() is None
        deleted = f.call("delete", path, params={"expected_revision": 3, "client_mutation_id": "delete-1"})
        assert f.call("delete", path, params={"expected_revision": 3, "client_mutation_id": "delete-1"}) == deleted
        f.call("get", path, expected=404)
        create_path = f"/api/recipes/cookbooks/{f.books[0]}/recipes"
        f.call("post", create_path, expected=404, json=payload())
        f.call("patch", path, expected=404, json=edit)
        with get_db() as db:
            assert db.execute("SELECT COUNT(*) FROM recipes").fetchone()[0] == 0


def test_image_projection_preserve_remove_and_invalid_rollback():
    with fixture() as f:
        recipe = create(f, {**payload(), "image_data": png_data()})
        path = f"/api/recipes/recipes/{recipe['id']}"
        assert recipe["image_version"] and recipe["image_url"].endswith("?v=" + recipe["image_version"])
        with get_db() as db:
            stored = db.execute("SELECT * FROM recipe_images WHERE recipe_id = ?", (recipe["id"],)).fetchone()
            assert stored["media_type"] == "image/webp" and bytes(stored["content"]).startswith(b"RIFF")
        kept = f.call("patch", path, json={"expected_revision": 1, "client_mutation_id": "keep-image", "title": "Same picture"})
        assert kept["image_version"] == recipe["image_version"]
        invalid = f.call("patch", path, expected=422, json={"expected_revision": 2, "client_mutation_id": "invalid-image", "ingredient_groups": [], "image_data": "https://example.invalid/image.png"})
        after = f.call("get", path)
        assert after["revision"] == 2 and after["ingredient_groups"] == kept["ingredient_groups"] and after["image_version"] == recipe["image_version"]
        with get_db() as db:
            assert db.execute("SELECT 1 FROM recipe_mutation_receipts WHERE client_mutation_id = 'invalid-image'").fetchone() is None
        removed = f.call("patch", path, json={"expected_revision": 2, "client_mutation_id": "remove-image", "image_data": None})
        assert removed["image_url"] is None and removed["image_version"] is None


def test_atomic_receipt_failure_and_concurrent_create_revision_writers():
    with fixture() as f:
        with patch.object(recipes, "_record_recipe_receipt", side_effect=RuntimeError("forced receipt failure")):
            try:
                asyncio.run(recipes.create_recipe(f.books[0], RecipeCreate.model_validate(payload()), f.users[0]))
            except RuntimeError:
                pass
            else:
                raise AssertionError("A receipt failure must abort the aggregate")
        with get_db() as db:
            assert db.execute("SELECT COUNT(*) FROM recipes").fetchone()[0] == db.execute("SELECT COUNT(*) FROM recipe_ingredients").fetchone()[0] == 0
            assert db.execute("SELECT COUNT(*) FROM recipe_step_ingredients").fetchone()[0] == 0
        barrier = threading.Barrier(2)
        def racing_create(_):
            barrier.wait(timeout=5)
            return asyncio.run(recipes.create_recipe(f.books[0], RecipeCreate.model_validate(payload()), f.users[0]))
        with ThreadPoolExecutor(max_workers=2) as executor:
            created = list(executor.map(racing_create, range(2)))
        assert created[0]["id"] == created[1]["id"]
        barrier = threading.Barrier(2)
        def racing_update(index):
            barrier.wait(timeout=5)
            try:
                return asyncio.run(recipes.update_recipe(created[0]["id"], RecipePatch.model_validate({"expected_revision": 1, "client_mutation_id": f"race-{index}", "title": f"Writer {index}"}), f.users[index]))["revision"]
            except HTTPException as error:
                return error.status_code
        with ThreadPoolExecutor(max_workers=2) as executor:
            assert sorted(executor.map(racing_update, range(2))) == [2, 409]
        with get_db() as db:
            assert db.execute("SELECT COUNT(*) FROM recipes").fetchone()[0] == 1
            assert db.execute("SELECT COUNT(*) FROM recipe_mutation_receipts").fetchone()[0] == 2


def test_scoped_child_keys_and_cookbook_cascade():
    with fixture() as f:
        first = create(f, {**payload(), "image_data": png_data()})
        second = create(f, payload("create-2"))
        assert first["ingredient_groups"][0]["id"] != second["ingredient_groups"][0]["id"]
        with get_db() as db:
            try:
                db.execute("UPDATE recipe_ingredients SET group_id = ? WHERE recipe_id = ?", (second["ingredient_groups"][0]["id"], first["id"]))
            except sqlite3.IntegrityError:
                pass
            else:
                raise AssertionError("Composite FK must forbid cross-recipe ingredient parents")
            db.rollback()
        f.actor["id"] = f.users[1]
        member_recipe = create(f)
        assert member_recipe["id"] not in (first["id"], second["id"]), "Creation receipts must remain actor scoped"
        f.actor["id"] = f.users[0]
        with get_db() as db:
            db.execute("DELETE FROM users WHERE id = ?", (f.users[1],))
            assert db.execute("SELECT created_by_user_id FROM recipes WHERE id = ?", (member_recipe["id"],)).fetchone()[0] is None
            assert db.execute("SELECT 1 FROM recipe_mutation_receipts WHERE user_id = ?", (f.users[1],)).fetchone() is None
        f.call("delete", f"/api/recipes/cookbooks/{f.books[0]}")
        with get_db() as db:
            for table in ("recipes", "recipe_ingredient_groups", "recipe_ingredients", "recipe_steps", "recipe_step_ingredients", "recipe_tags", "recipe_images"):
                assert db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0, table
            assert all(row["recipe_id"] is None and row["cookbook_id"] is None for row in db.execute("SELECT * FROM recipe_mutation_receipts"))
            assert db.execute("PRAGMA foreign_key_check").fetchall() == []


if __name__ == "__main__":
    tests = [value for name, value in globals().items() if name.startswith("test_") and callable(value)]
    for test in tests:
        test()
        print("✅ " + test.__name__)
    print(f"Recipe aggregate contracts passed: {len(tests)}/{len(tests)}")
