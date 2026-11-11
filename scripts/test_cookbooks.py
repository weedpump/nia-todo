#!/usr/bin/env python3
"""Disposable cookbook CRUD, generic sharing and household boundary regression."""

import asyncio
import contextlib
import io
import os
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory(prefix="nia-cookbook-test-") as temporary:
        os.environ["NIA_TODO_DATA_DIR"] = temporary
        sys.path.insert(0, str(ROOT / "api"))
        from db import get_db
        from migrate import run_migrations
        from routers import entity_sharing, recipes
        from routers.auth import require_auth
        from routers.households import dissolve_household_endpoint
        from routers.websocket import get_sync_payload
        from services.entity_access import create_household, invite_household_member, respond_to_household_invite
        from services.recipes import get_sync_cookbooks

        with contextlib.redirect_stdout(io.StringIO()):
            run_migrations()
        with get_db() as db:
            users = [db.execute("INSERT INTO users (username, display_name) VALUES (?, ?)", (f"cook-user-{number}", f"User {number}")).lastrowid for number in range(5)]
            household = create_household(db, "Home", users[0])
            accepted = invite_household_member(db, household, users[0], users[2])
            respond_to_household_invite(db, accepted, users[2], accept=True)
            invite_household_member(db, household, users[0], users[3])
            foreign_household = create_household(db, "Other", users[4])
            db.commit()
        actor = {"id": users[0]}
        app = FastAPI()
        app.include_router(recipes.router)
        app.include_router(entity_sharing.router)
        app.dependency_overrides[require_auth] = lambda: actor["id"]
        changes = AsyncMock()
        with patch.object(recipes, "broadcast_sync_to_users", changes), patch.object(entity_sharing, "broadcast_sync_to_users", changes), \
             patch.object(entity_sharing, "notify_entity_share_invite", AsyncMock(return_value="in_app")), TestClient(app) as client:
            def call(method, path, expected=200, **kwargs):
                response = getattr(client, method)(path, **kwargs)
                assert response.status_code == expected, (method, path, response.status_code, response.text)
                return response.json()

            with patch.object(recipes, "get_db", side_effect=AssertionError("Invalid IDs must be rejected before accessing SQLite")):
                for invalid_id in (0, -1, 9223372036854775808):
                    call("get", f"/api/recipes/cookbooks/{invalid_id}", expected=422)
            payload = {"name": "Family meals", "description": "Weeknight recipes", "color": "#112233", "icon": "book-open", "client_mutation_id": "create-1"}
            book = call("post", "/api/recipes/cookbooks", json=payload)
            path = f"/api/recipes/cookbooks/{book['id']}"
            assert book["owner_user_id"] == users[0] and book["owner_household_id"] is None
            assert book["ownership_type"] == "user" and book["is_owner"] and book["can_manage"] and book["can_edit"]
            assert book["owner_username"] == "cook-user-0" and book["description"] == payload["description"]
            before_replay_broadcasts = changes.await_count
            assert call("post", "/api/recipes/cookbooks", json=payload)["id"] == book["id"]
            assert changes.await_count == before_replay_broadcasts, "A retry must not mutate or rebroadcast"
            race_start = threading.Barrier(2)
            def create_concurrently(_):
                race_start.wait(timeout=5)
                return asyncio.run(recipes.create_cookbook(recipes.CookbookCreate(name="Concurrent", client_mutation_id="race-create"), users[0]))
            with ThreadPoolExecutor(max_workers=2) as executor:
                concurrent = list(executor.map(create_concurrently, range(2)))
            assert concurrent[0]["id"] == concurrent[1]["id"], "SQLite writer serialization must acknowledge one concurrent create"
            with patch.object(recipes, "register_personal_entity", side_effect=RuntimeError("forced access registration failure")):
                try:
                    asyncio.run(recipes.create_cookbook(recipes.CookbookCreate(name="Must roll back", client_mutation_id="failed-create"), users[0]))
                except RuntimeError as error:
                    assert "forced access registration" in str(error)
                else:
                    raise AssertionError("Injected registration failure must propagate")
            with get_db() as db:
                assert db.execute("SELECT COUNT(*) FROM cookbooks WHERE client_mutation_id = 'race-create'").fetchone()[0] == 1
                assert db.execute("SELECT COUNT(*) FROM cookbook_creation_receipts WHERE user_id = ? AND client_mutation_id = 'race-create'", (users[0],)).fetchone()[0] == 1
                assert db.execute("SELECT 1 FROM cookbooks WHERE client_mutation_id = 'failed-create'").fetchone() is None
                assert db.execute("SELECT 1 FROM cookbook_creation_receipts WHERE client_mutation_id = 'failed-create'").fetchone() is None, "Receipt and cookbook must roll back together"
            edited = call("patch", path, json={"description": "", "name": "Favorites", "sort_order": 3, "icon": None})
            assert edited["description"] == "" and edited["name"] == "Favorites" and edited["sort_order"] == 3 and edited["icon"] is None
            for invalid in ({"sort_order": None}, {"sort_order": 9223372036854775808}, {"description": None}, {"description": "x" * 4001}, {"name": "  "}, {"color": "invalid"}):
                call("patch", path, expected=422, json=invalid)
            assert len(call("patch", path, json={"description": "x" * 4000})["description"]) == 4000
            call("post", "/api/recipes/cookbooks", expected=422, json={"name": "Book", "client_mutation_id": "  "})

            actor["id"] = users[1]
            other_book = call("post", "/api/recipes/cookbooks", json=payload)
            assert other_book["id"] != book["id"], "Create receipts must be actor scoped"
            call("get", path, expected=404)
            assert {row["id"] for row in call("get", "/api/recipes/cookbooks")["cookbooks"]} == {other_book["id"]}
            actor["id"] = users[0]
            invite = call("post", f"/api/entity-sharing/cookbook/{book['id']}/invites", json={"identifier": "cook-user-1"})
            assert invite["status"] == "pending"
            actor["id"] = users[1]
            call("get", path, expected=404)
            with get_db() as db:
                pending_snapshot = get_sync_payload(db, users[1])
                assert book["id"] not in {row["id"] for row in pending_snapshot["cookbooks"]}
                pending_invite = next(row for row in pending_snapshot["cookbook_invites"] if row["id"] == invite["id"])
                assert pending_invite["entity_name"] == "Favorites" and "description" not in pending_invite
            call("post", f"/api/entity-sharing/cookbook/{book['id']}/invites/{invite['id']}", json={"accept": True})
            shared = call("get", path)
            assert shared["can_edit"] and not shared["can_manage"] and not shared["is_owner"] and shared["is_shared"]
            with get_db() as db:
                accepted_snapshot = get_sync_payload(db, users[1])
                assert book["id"] in {row["id"] for row in accepted_snapshot["cookbooks"]}
                assert accepted_snapshot["cookbook_invites"] == []
            call("patch", path, expected=404, json={"name": "Unauthorized rename"})
            call("delete", path, expected=404)
            actor["id"] = users[0]
            members = call("get", f"/api/entity-sharing/cookbook/{book['id']}/members")["members"]
            assert any(member["id"] == users[1] and member["status"] == "accepted" for member in members)
            call("delete", f"/api/entity-sharing/cookbook/{book['id']}/members/{users[1]}")
            actor["id"] = users[1]
            call("get", path, expected=404)
            actor["id"] = users[0]
            call("post", f"/api/entity-sharing/cookbook/{book['id']}/members/{users[1]}/restore", json={"status": "accepted"})
            actor["id"] = users[1]
            call("post", f"/api/entity-sharing/cookbook/{book['id']}/leave")
            call("get", path, expected=404)
            call("post", f"/api/entity-sharing/cookbook/{book['id']}/members/{users[1]}/restore", json={"status": "accepted"})
            assert call("get", path)["can_edit"]

            actor["id"] = users[3]
            call("post", "/api/recipes/cookbooks", expected=403, json={"name": "Not accepted", "household_id": household})
            actor["id"] = users[2]
            household_payload = {"name": "Household meals", "household_id": household, "client_mutation_id": "household-create"}
            household_book = call("post", "/api/recipes/cookbooks", json=household_payload)
            assert household_book["ownership_type"] == "household" and household_book["owner_household_id"] == household
            assert household_book["can_edit"] and not household_book["can_manage"] and household_book["household_name"] == "Home"
            call("patch", f"/api/recipes/cookbooks/{household_book['id']}", expected=404, json={"name": "Participant cannot manage"})
            actor["id"] = users[0]
            call("patch", f"/api/recipes/cookbooks/{household_book['id']}", json={"name": "Managed by household owner"})
            call("post", path + "/household", expected=403, json={"household_id": foreign_household})
            transferred = call("post", path + "/household", json={"household_id": household})
            assert transferred["owner_user_id"] is None and transferred["owner_household_id"] == household
            assert set(changes.await_args.args[0]) == {users[0], users[1], users[2]}, "Transfer must refresh old and new recipients"
            actor["id"] = users[1]
            call("get", path, expected=404)
            actor["id"] = users[3]
            call("get", path, expected=404)
            actor["id"] = users[0]
            call("post", f"/api/entity-sharing/cookbook/{book['id']}/invites", expected=409, json={"identifier": "cook-user-1"})
            assert call("post", "/api/recipes/cookbooks", json=payload)["id"] == book["id"], "A receipt survives ownership transfer when its actor remains authorized"

            with get_db() as db:
                before = db.execute("SELECT COUNT(*) FROM cookbooks").fetchone()[0]
                db.execute("UPDATE household_members SET status = 'removed' WHERE household_id = ? AND user_id = ?", (household, users[2]))
                db.commit()
            actor["id"] = users[2]
            call("post", "/api/recipes/cookbooks", expected=404, json=household_payload)
            with get_db() as db:
                assert db.execute("SELECT COUNT(*) FROM cookbooks").fetchone()[0] == before, "Revoked receipt replay must not create a duplicate"
                assert get_sync_cookbooks(db, users[2]) == []
                db.execute("DELETE FROM users WHERE id = ?", (users[2],))
                db.commit()
                assert db.execute("SELECT created_by_user_id FROM cookbooks WHERE id = ?", (household_book["id"],)).fetchone()[0] is None
                assert db.execute("SELECT 1 FROM cookbook_creation_receipts WHERE user_id = ?", (users[2],)).fetchone() is None, "Deleted accounts must not retain personal receipts"
            with patch("routers.households.broadcast_sync_to_users", AsyncMock()):
                asyncio.run(dissolve_household_endpoint(household, users[0]))
            actor["id"] = users[0]
            assert call("get", path)["owner_user_id"] == users[0], "Household dissolution must preserve cookbook ownership"
            call("delete", path)
            call("get", path, expected=404)
            before_deleted_replay_broadcasts = changes.await_count
            with get_db() as db:
                before_deleted_replay_count = db.execute("SELECT COUNT(*) FROM cookbooks").fetchone()[0]
                assert db.execute("SELECT cookbook_id FROM cookbook_creation_receipts WHERE user_id = ? AND client_mutation_id = ?", (users[0], payload["client_mutation_id"])).fetchone()[0] is None
            call("post", "/api/recipes/cookbooks", expected=404, json=payload)
            assert changes.await_count == before_deleted_replay_broadcasts, "A deleted creation receipt must not mutate or rebroadcast"
            with get_db() as db:
                assert db.execute("SELECT COUNT(*) FROM cookbooks").fetchone()[0] == before_deleted_replay_count, "An ambiguous late create retry must never resurrect a deleted cookbook"
                assert db.execute("SELECT 1 FROM entity_access WHERE entity_type = 'cookbook' AND entity_id = ?", (book["id"],)).fetchone() is None
                assert db.execute("PRAGMA foreign_key_check").fetchall() == []
        print("✅ Cookbook CRUD, actor receipts, generic sharing, revocation and household lifecycle passed")


if __name__ == "__main__":
    main()
