#!/usr/bin/env python3
"""Realtime snapshots stay authoritative across pending access boundaries."""

import asyncio
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

with tempfile.TemporaryDirectory() as tmp:
    os.environ["NIA_TODO_DATA_DIR"] = tmp
    sys.path.insert(0, str(ROOT / "api"))

    from db import get_db
    from migrate import run_migrations
    from routers.admin import delete_user
    from routers.projects import ProjectHouseholdTransfer, transfer_project_to_household_endpoint
    from routers.shopping import (
        ShoppingListCreate,
        ShoppingListHouseholdTransfer,
        create_shopping_list,
        delete_shopping_list,
        transfer_shopping_list_to_household,
    )
    import services.websocket as websocket_service
    from services.entity_access import (
        create_household,
        grant_entity_access,
        invite_entity_access,
        register_personal_entity,
    )
    from services.sharing import get_project_boundary_user_ids

    run_migrations()

    with get_db() as db:
        project_owner_id = db.execute("INSERT INTO users (username) VALUES ('project-owner')").lastrowid
        pending_project_user_id = db.execute("INSERT INTO users (username) VALUES ('pending-project-user')").lastrowid
        project_id = db.execute(
            "INSERT INTO projects (name, user_id) VALUES ('Pending boundary', ?)",
            (project_owner_id,),
        ).lastrowid
        register_personal_entity(db, "project", project_id, project_owner_id)
        invite_entity_access(db, "project", project_id, project_owner_id, pending_project_user_id)
        db.commit()

    project_delete_messages = {}
    original_broadcast_to_user = websocket_service.manager.broadcast_to_user

    async def capture_project_delete(user_id, message):
        project_delete_messages.setdefault(user_id, []).append(message)
        return True

    websocket_service.manager.broadcast_to_user = capture_project_delete
    try:
        asyncio.run(delete_user(project_owner_id, True))
    finally:
        websocket_service.manager.broadcast_to_user = original_broadcast_to_user

    pending_project_messages = project_delete_messages.get(pending_project_user_id, [])
    assert [message["type"] for message in pending_project_messages] == ["sync_response"], project_delete_messages
    assert pending_project_messages[0]["projects"] == [], pending_project_messages

    with get_db() as db:
        shopping_owner_id = db.execute("INSERT INTO users (username) VALUES ('shopping-owner')").lastrowid
        pending_shopping_user_id = db.execute("INSERT INTO users (username) VALUES ('pending-shopping-user')").lastrowid
        db.commit()
    shopping_list = asyncio.run(create_shopping_list(ShoppingListCreate(name="Delete boundary"), shopping_owner_id))
    with get_db() as db:
        invite_entity_access(
            db,
            "shopping_list",
            shopping_list["id"],
            shopping_owner_id,
            pending_shopping_user_id,
        )
        db.commit()

    shopping_delete_messages = {}

    async def capture_shopping_delete(user_id, message):
        shopping_delete_messages.setdefault(user_id, []).append(message)
        return True

    websocket_service.manager.broadcast_to_user = capture_shopping_delete
    try:
        asyncio.run(delete_shopping_list(shopping_list["id"], shopping_owner_id))
    finally:
        websocket_service.manager.broadcast_to_user = original_broadcast_to_user

    pending_shopping_messages = shopping_delete_messages.get(pending_shopping_user_id, [])
    assert [message["type"] for message in pending_shopping_messages] == ["sync_response"], shopping_delete_messages
    assert pending_shopping_messages[0]["shopping_lists"] == [], pending_shopping_messages
    assert pending_shopping_messages[0]["shopping_invites"] == [], pending_shopping_messages

    with get_db() as db:
        transfer_owner_id = db.execute("INSERT INTO users (username) VALUES ('transfer-owner')").lastrowid
        pending_transfer_user_id = db.execute("INSERT INTO users (username) VALUES ('pending-transfer-user')").lastrowid
        household_id = create_household(db, "Transfer household", transfer_owner_id)
        db.commit()
    transfer_list = asyncio.run(create_shopping_list(ShoppingListCreate(name="Transfer boundary"), transfer_owner_id))
    with get_db() as db:
        transfer_invite = invite_entity_access(
            db,
            "shopping_list",
            transfer_list["id"],
            transfer_owner_id,
            pending_transfer_user_id,
        )
        db.commit()

    transfer_messages = {}

    async def capture_transfer(user_id, message):
        transfer_messages.setdefault(user_id, []).append(message)
        return True

    websocket_service.manager.broadcast_to_user = capture_transfer
    try:
        asyncio.run(
            transfer_shopping_list_to_household(
                transfer_list["id"],
                ShoppingListHouseholdTransfer(household_id=household_id),
                transfer_owner_id,
            )
        )
    finally:
        websocket_service.manager.broadcast_to_user = original_broadcast_to_user

    pending_transfer_messages = transfer_messages.get(pending_transfer_user_id, [])
    assert [message["type"] for message in pending_transfer_messages] == ["sync_response"], transfer_messages
    assert pending_transfer_messages[0]["shopping_lists"] == [], pending_transfer_messages
    assert pending_transfer_messages[0]["shopping_invites"] == [], pending_transfer_messages
    with get_db() as db:
        assert not db.execute(
            "SELECT 1 FROM entity_access_grants WHERE id = ?",
            (transfer_invite["id"],),
        ).fetchone()

    with get_db() as db:
        inherited_owner_id = db.execute(
            "INSERT INTO users (username) VALUES ('inherited-boundary-owner')"
        ).lastrowid
        inherited_recipient_id = db.execute(
            "INSERT INTO users (username) VALUES ('inherited-boundary-recipient')"
        ).lastrowid
        ancestor_pending_id = db.execute(
            "INSERT INTO users (username) VALUES ('ancestor-pending-recipient')"
        ).lastrowid
        child_pending_id = db.execute(
            "INSERT INTO users (username) VALUES ('child-pending-recipient')"
        ).lastrowid
        inherited_household_id = create_household(db, "Inherited boundary household", inherited_owner_id)
        parent_project_id = db.execute(
            "INSERT INTO projects (name, user_id) VALUES ('Shared parent', ?)",
            (inherited_owner_id,),
        ).lastrowid
        child_project_id = db.execute(
            "INSERT INTO projects (name, user_id, parent_id) VALUES ('Transferred child', ?, ?)",
            (inherited_owner_id, parent_project_id),
        ).lastrowid
        register_personal_entity(db, "project", parent_project_id, inherited_owner_id)
        register_personal_entity(db, "project", child_project_id, inherited_owner_id)
        grant_entity_access(
            db,
            "project",
            parent_project_id,
            inherited_owner_id,
            inherited_recipient_id,
        )
        invite_entity_access(
            db,
            "project",
            parent_project_id,
            inherited_owner_id,
            ancestor_pending_id,
        )
        invite_entity_access(
            db,
            "project",
            child_project_id,
            inherited_owner_id,
            child_pending_id,
        )
        db.commit()
        assert get_project_boundary_user_ids(db, child_project_id) == {
            inherited_owner_id,
            inherited_recipient_id,
            child_pending_id,
        }

    inherited_transfer_messages = {}

    async def capture_inherited_transfer(user_id, message):
        inherited_transfer_messages.setdefault(user_id, []).append(message)
        return True

    websocket_service.manager.broadcast_to_user = capture_inherited_transfer
    try:
        asyncio.run(
            transfer_project_to_household_endpoint(
                child_project_id,
                ProjectHouseholdTransfer(household_id=inherited_household_id),
                inherited_owner_id,
            )
        )
    finally:
        websocket_service.manager.broadcast_to_user = original_broadcast_to_user

    inherited_syncs = [
        message
        for message in inherited_transfer_messages.get(inherited_recipient_id, [])
        if message.get("type") == "sync_response"
    ]
    assert inherited_syncs, inherited_transfer_messages
    assert child_project_id not in {
        project["id"] for project in inherited_syncs[-1]["projects"]
    }, inherited_syncs[-1]
    child_pending_syncs = [
        message
        for message in inherited_transfer_messages.get(child_pending_id, [])
        if message.get("type") == "sync_response"
    ]
    assert child_pending_syncs, inherited_transfer_messages
    assert inherited_transfer_messages.get(ancestor_pending_id, []) == [], inherited_transfer_messages

print("✅ Pending and inherited entity-sharing boundaries receive authoritative snapshots")
