#!/usr/bin/env python3
"""Household API exposes invitation and ownership lifecycle without UI."""

import asyncio
import os
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

with tempfile.TemporaryDirectory() as tmp:
    os.environ["NIA_TODO_DATA_DIR"] = tmp
    sys.path.insert(0, str(ROOT / "api"))

    from fastapi import HTTPException

    from db import get_db
    from migrate import run_migrations
    import routers.households as households_router
    from routers.households import (
        HouseholdCreate,
        HouseholdInviteCreate,
        HouseholdInviteResponse,
        HouseholdOwnerTransfer,
        create_household_endpoint,
        dissolve_household_endpoint,
        get_current_household,
        invite_household_member_endpoint,
        leave_household_endpoint,
        list_household_invites,
        remove_household_member_endpoint,
        respond_to_household_invite_endpoint,
        transfer_household_owner_endpoint,
    )
    from routers.projects import ProjectCreate, create_project
    from services.websocket import manager

    class FakeSocket:
        def __init__(self):
            self.messages = []

        async def send_json(self, message):
            self.messages.append(message)

    run_migrations()

    with get_db() as db:
        owner_id = db.execute("INSERT INTO users (username) VALUES ('owner')").lastrowid
        member_id = db.execute("INSERT INTO users (username) VALUES ('member')").lastrowid
        outsider_id = db.execute("INSERT INTO users (username) VALUES ('outsider')").lastrowid
        race_owner_id = db.execute("INSERT INTO users (username) VALUES ('race-owner')").lastrowid
        race_target_id = db.execute("INSERT INTO users (username) VALUES ('race-target')").lastrowid
        db.commit()

    race_household = asyncio.run(create_household_endpoint(HouseholdCreate(name="Race home"), race_owner_id))
    race_household_id = race_household["household"]["id"]
    race_invite = asyncio.run(
        invite_household_member_endpoint(
            race_household_id,
            HouseholdInviteCreate(username="race-target"),
            race_owner_id,
        )
    )
    asyncio.run(
        respond_to_household_invite_endpoint(
            race_household_id,
            race_invite["invite"]["id"],
            HouseholdInviteResponse(accept=True),
            race_target_id,
        )
    )
    transfer_started = threading.Event()
    allow_transfer = threading.Event()
    transfer_errors = []
    leave_errors = []
    original_sync_user_ids = households_router._household_sync_user_ids

    def pause_transfer_with_writer_lock(db, target_household_id, *additional_user_ids):
        result = original_sync_user_ids(db, target_household_id, *additional_user_ids)
        if (
            threading.current_thread().name == "household-owner-transfer"
            and target_household_id == race_household_id
            and not transfer_started.is_set()
        ):
            transfer_started.set()
            assert allow_transfer.wait(timeout=5)
        return result

    def run_owner_transfer():
        try:
            asyncio.run(
                transfer_household_owner_endpoint(
                    race_household_id,
                    HouseholdOwnerTransfer(user_id=race_target_id),
                    race_owner_id,
                )
            )
        except Exception as error:
            transfer_errors.append(error)

    def run_concurrent_leave():
        try:
            asyncio.run(leave_household_endpoint(race_household_id, race_target_id))
        except Exception as error:
            leave_errors.append(error)

    households_router._household_sync_user_ids = pause_transfer_with_writer_lock
    transfer_thread = threading.Thread(target=run_owner_transfer, name="household-owner-transfer")
    leave_thread = threading.Thread(target=run_concurrent_leave)
    try:
        transfer_thread.start()
        assert transfer_started.wait(timeout=5), "owner transfer did not reach serialized validation"
        leave_thread.start()
        leave_thread.join(timeout=0.1)
        assert leave_thread.is_alive(), "concurrent leave bypassed household writer serialization"
        allow_transfer.set()
        transfer_thread.join(timeout=5)
        leave_thread.join(timeout=5)
    finally:
        allow_transfer.set()
        households_router._household_sync_user_ids = original_sync_user_ids
    assert not transfer_thread.is_alive() and not leave_thread.is_alive()
    assert not transfer_errors, transfer_errors
    assert len(leave_errors) == 1, leave_errors
    assert isinstance(leave_errors[0], HTTPException) and leave_errors[0].status_code == 409, leave_errors
    with get_db() as db:
        race_owner = db.execute(
            "SELECT owner_user_id FROM households WHERE id = ?", (race_household_id,)
        ).fetchone()
        assert race_owner["owner_user_id"] == race_target_id

    created = asyncio.run(create_household_endpoint(HouseholdCreate(name="Home"), owner_id))
    household_id = created["household"]["id"]
    assert created["household"]["role"] == "owner", created
    household_project = asyncio.run(
        create_project(ProjectCreate(name="Household project", household_id=household_id), owner_id)
    )
    owner_socket = FakeSocket()
    member_socket = FakeSocket()
    outsider_socket = FakeSocket()
    manager.connections = {
        owner_id: [owner_socket],
        member_id: [member_socket],
        outsider_id: [outsider_socket],
    }

    try:
        asyncio.run(create_household_endpoint(HouseholdCreate(name="Second"), owner_id))
    except HTTPException as error:
        assert error.status_code == 409, error
    else:
        raise AssertionError("owner created a second household")

    invite = asyncio.run(
        invite_household_member_endpoint(
            household_id,
            HouseholdInviteCreate(username="member"),
            owner_id,
        )
    )
    invite_id = invite["invite"]["id"]
    assert invite["invite"]["status"] == "pending", invite
    member_sync = [message for message in member_socket.messages if message.get("type") == "sync_response"]
    assert member_sync, member_socket.messages
    assert invite_id in {row["id"] for row in member_sync[-1]["household_invites"]}

    pending = list_household_invites(member_id)
    assert [row["id"] for row in pending["invites"]] == [invite_id], pending

    accepted = asyncio.run(
        respond_to_household_invite_endpoint(
            household_id,
            invite_id,
            HouseholdInviteResponse(accept=True),
            member_id,
        )
    )
    assert accepted["status"] == "accepted", accepted
    member_sync = [message for message in member_socket.messages if message.get("type") == "sync_response"]
    owner_sync = [message for message in owner_socket.messages if message.get("type") == "sync_response"]
    assert member_sync, member_socket.messages
    assert owner_sync, owner_socket.messages
    assert member_sync[-1]["household_invites"] == []
    assert household_project["id"] in {project["id"] for project in member_sync[-1]["projects"]}
    assert member_id in {member["user_id"] for member in owner_sync[-1]["household"]["members"]}

    current = get_current_household(member_id)
    assert current["household"]["id"] == household_id, current
    assert current["household"]["role"] == "member", current

    try:
        asyncio.run(
            invite_household_member_endpoint(
                household_id,
                HouseholdInviteCreate(username="outsider"),
                member_id,
            )
        )
    except HTTPException as error:
        assert error.status_code == 403, error
    else:
        raise AssertionError("ordinary member invited another user")

    try:
        asyncio.run(leave_household_endpoint(household_id, owner_id))
    except HTTPException as error:
        assert error.status_code == 409, error
    else:
        raise AssertionError("household owner left without transferring ownership")

    transferred = asyncio.run(
        transfer_household_owner_endpoint(
            household_id,
            HouseholdOwnerTransfer(user_id=member_id),
            owner_id,
        )
    )
    assert transferred["household"]["owner_user_id"] == member_id, transferred
    owner_sync = [message for message in owner_socket.messages if message.get("type") == "sync_response"]
    member_sync = [message for message in member_socket.messages if message.get("type") == "sync_response"]
    assert owner_sync and member_sync
    assert next(project for project in owner_sync[-1]["projects"] if project["id"] == household_project["id"])["is_owner"] == 0
    assert next(project for project in member_sync[-1]["projects"] if project["id"] == household_project["id"])["is_owner"] == 1
    assert get_current_household(owner_id)["household"]["role"] == "member"

    left = asyncio.run(leave_household_endpoint(household_id, owner_id))
    assert left["status"] == "left", left
    assert get_current_household(owner_id)["household"] is None
    owner_sync = [message for message in owner_socket.messages if message.get("type") == "sync_response"]
    assert household_project["id"] not in {project["id"] for project in owner_sync[-1]["projects"]}
    member_sync = [message for message in member_socket.messages if message.get("type") == "sync_response"]
    assert owner_id not in {member["user_id"] for member in member_sync[-1]["household"]["members"]}

    outsider_invite = asyncio.run(
        invite_household_member_endpoint(
            household_id,
            HouseholdInviteCreate(username="outsider"),
            member_id,
        )
    )
    outsider_invite_id = outsider_invite["invite"]["id"]
    asyncio.run(
        respond_to_household_invite_endpoint(
            household_id,
            outsider_invite_id,
            HouseholdInviteResponse(accept=True),
            outsider_id,
        )
    )
    outsider_sync = [message for message in outsider_socket.messages if message.get("type") == "sync_response"]
    assert household_project["id"] in {project["id"] for project in outsider_sync[-1]["projects"]}
    member_sync_before_removal = len([
        message for message in member_socket.messages if message.get("type") == "sync_response"
    ])
    with get_db() as db:
        db.execute(
            """INSERT INTO project_members (project_id, user_id, invited_by, status)
               VALUES (?, ?, ?, 'accepted')""",
            (household_project["id"], outsider_id, member_id),
        )
        db.commit()
    removed = asyncio.run(remove_household_member_endpoint(household_id, outsider_id, member_id))
    assert removed["status"] == "removed", removed
    assert get_current_household(outsider_id)["household"] is None
    outsider_sync = [message for message in outsider_socket.messages if message.get("type") == "sync_response"]
    assert household_project["id"] in {project["id"] for project in outsider_sync[-1]["projects"]}
    assert outsider_sync[-1]["household"] is None
    member_sync = [message for message in member_socket.messages if message.get("type") == "sync_response"]
    assert len(member_sync) > member_sync_before_removal
    assert outsider_id not in {member["user_id"] for member in member_sync[-1]["household"]["members"]}

    pending_at_dissolution = asyncio.run(
        invite_household_member_endpoint(
            household_id,
            HouseholdInviteCreate(username="outsider"),
            member_id,
        )
    )
    pending_id = pending_at_dissolution["invite"]["id"]
    outsider_sync = [message for message in outsider_socket.messages if message.get("type") == "sync_response"]
    assert pending_id in {row["id"] for row in outsider_sync[-1]["household_invites"]}

    dissolved = asyncio.run(dissolve_household_endpoint(household_id, member_id))
    assert dissolved == {"deleted": household_id, "transferred_entity_count": 1}, dissolved
    with get_db() as db:
        assert db.execute("SELECT 1 FROM households WHERE id = ?", (household_id,)).fetchone() is None
        ownership = db.execute(
            """SELECT owner_user_id, owner_household_id FROM entity_access
               WHERE entity_type = 'project' AND entity_id = ?""",
            (household_project["id"],),
        ).fetchone()
        assert ownership["owner_user_id"] == member_id, ownership
        assert ownership["owner_household_id"] is None, ownership
    assert get_current_household(member_id)["household"] is None
    member_sync = [message for message in member_socket.messages if message.get("type") == "sync_response"]
    outsider_sync = [message for message in outsider_socket.messages if message.get("type") == "sync_response"]
    assert next(project for project in member_sync[-1]["projects"] if project["id"] == household_project["id"])["is_owner"] == 1
    assert household_project["id"] in {project["id"] for project in outsider_sync[-1]["projects"]}
    assert outsider_sync[-1]["household_invites"] == []
    assert member_sync[-1]["household"] is None

    manager.connections.clear()

print("✅ Household API invitation and ownership lifecycle works")
