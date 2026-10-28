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
    from starlette.requests import Request

    from db import get_db
    from migrate import run_migrations
    import routers.households as households_router
    from routers.households import (
        HouseholdCreate,
        HouseholdInviteCreate,
        HouseholdInviteResponse,
        HouseholdOwnerTransfer,
        HouseholdUpdate,
        create_household_endpoint,
        dissolve_household_endpoint,
        get_current_household,
        invite_household_member_endpoint,
        leave_household_endpoint,
        list_household_invites,
        remove_household_member_endpoint,
        respond_to_household_invite_endpoint,
        transfer_household_owner_endpoint,
        update_household_endpoint,
    )
    from routers.projects import ProjectCreate, create_project
    from services.websocket import manager

    class FakeSocket:
        def __init__(self):
            self.messages = []

        async def send_json(self, message):
            self.messages.append(message)

    def request(path="/api/households/1/invites"):
        return Request({
            "type": "http",
            "method": "POST",
            "scheme": "https",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "headers": [(b"host", b"todo.example.invalid")],
            "client": ("127.0.0.1", 12345),
            "server": ("todo.example.invalid", 443),
        })

    run_migrations()

    with get_db() as db:
        owner_id = db.execute("INSERT INTO users (username) VALUES ('owner')").lastrowid
        member_id = db.execute("INSERT INTO users (username) VALUES ('member')").lastrowid
        outsider_id = db.execute("INSERT INTO users (username) VALUES ('outsider')").lastrowid
        race_owner_id = db.execute("INSERT INTO users (username) VALUES ('race-owner')").lastrowid
        race_target_id = db.execute("INSERT INTO users (username) VALUES ('race-target')").lastrowid
        email_target_id = db.execute(
            """INSERT INTO users (username, display_name, email, email_verified_at, language)
               VALUES ('email-target', 'Email Target', 'target@example.invalid', datetime('now'), 'en')"""
        ).lastrowid
        email_fail_target_id = db.execute(
            """INSERT INTO users (username, display_name, email, email_verified_at, language)
               VALUES ('email-fail-target', 'Email Fail Target', 'fail@example.invalid', datetime('now'), 'fr')"""
        ).lastrowid
        unverified_email_target_id = db.execute(
            """INSERT INTO users (username, email, language)
               VALUES ('unverified-target', 'unverified@example.invalid', 'de')"""
        ).lastrowid
        at_username_id = db.execute("INSERT INTO users (username) VALUES ('looks@like.email')").lastrowid
        db.commit()

    race_household = asyncio.run(create_household_endpoint(HouseholdCreate(name="Race home"), race_owner_id))
    race_household_id = race_household["household"]["id"]
    race_invite = asyncio.run(
        invite_household_member_endpoint(
            race_household_id,
            HouseholdInviteCreate(username="race-target"),
            request(),
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

    renamed = asyncio.run(update_household_endpoint(household_id, HouseholdUpdate(name="Renamed home"), owner_id))
    assert renamed["household"]["name"] == "Renamed home", renamed
    owner_sync = [message for message in owner_socket.messages if message.get("type") == "sync_response"]
    assert owner_sync[-1]["household"]["name"] == "Renamed home", owner_socket.messages

    for invalid_name in ("", "x" * 121):
        try:
            HouseholdUpdate(name=invalid_name)
        except Exception:
            pass
        else:
            raise AssertionError(f"invalid household name accepted: {invalid_name!r}")

    try:
        asyncio.run(create_household_endpoint(HouseholdCreate(name="Second"), owner_id))
    except HTTPException as error:
        assert error.status_code == 409, error
    else:
        raise AssertionError("owner created a second household")

    sent_emails = []
    original_can_send_email_links = households_router.can_send_email_links
    original_get_public_base_url = households_router.get_public_base_url
    original_send_email = households_router.send_email
    households_router.can_send_email_links = lambda: True
    households_router.get_public_base_url = lambda request, require_configured=False: "https://todo.example.invalid"
    households_router.send_email = lambda **kwargs: sent_emails.append(kwargs)
    try:
        email_invite = asyncio.run(
            invite_household_member_endpoint(
                household_id,
                HouseholdInviteCreate(username="target@example.invalid"),
                request(),
                owner_id,
            )
        )
        assert email_invite["notification_delivery"] == "email", email_invite
        assert sent_emails and sent_emails[-1]["to"] == "target@example.invalid", sent_emails
        assert "Household invitation" in sent_emails[-1]["subject"], sent_emails[-1]

        username_invite = asyncio.run(
            invite_household_member_endpoint(
                household_id,
                HouseholdInviteCreate(username="unverified-target"),
                request(),
                owner_id,
            )
        )
        assert username_invite["notification_delivery"] == "in_app", username_invite
        assert username_invite["invite"]["user_id"] == unverified_email_target_id, username_invite

        for private_identifier in ("unverified@example.invalid", "looks@like.email"):
            try:
                asyncio.run(
                    invite_household_member_endpoint(
                        household_id,
                        HouseholdInviteCreate(username=private_identifier),
                        request(),
                        owner_id,
                    )
                )
            except HTTPException as error:
                assert error.status_code == 404, error
            else:
                raise AssertionError(f"private email identifier matched unexpectedly: {private_identifier}")

        def fail_email(**kwargs):
            raise RuntimeError("smtp unavailable")

        households_router.send_email = fail_email
        failed_email_invite = asyncio.run(
            invite_household_member_endpoint(
                household_id,
                HouseholdInviteCreate(username="fail@example.invalid"),
                request(),
                owner_id,
            )
        )
        assert failed_email_invite["notification_delivery"] == "in_app", failed_email_invite
        with get_db() as db:
            persisted = db.execute(
                "SELECT status FROM household_members WHERE household_id = ? AND user_id = ?",
                (household_id, email_fail_target_id),
            ).fetchone()
            assert persisted and persisted["status"] == "pending", persisted
    finally:
        households_router.can_send_email_links = original_can_send_email_links
        households_router.get_public_base_url = original_get_public_base_url
        households_router.send_email = original_send_email

    invite = asyncio.run(
        invite_household_member_endpoint(
            household_id,
            HouseholdInviteCreate(username="member"),
            request(),
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
        asyncio.run(update_household_endpoint(household_id, HouseholdUpdate(name="Member rename"), member_id))
    except HTTPException as error:
        assert error.status_code == 403, error
    else:
        raise AssertionError("ordinary member renamed household")

    owner_sync_before_rename = len([message for message in owner_socket.messages if message.get("type") == "sync_response"])
    member_sync_before_rename = len([message for message in member_socket.messages if message.get("type") == "sync_response"])
    renamed = asyncio.run(update_household_endpoint(household_id, HouseholdUpdate(name="Family home"), owner_id))
    assert renamed["household"]["name"] == "Family home", renamed
    owner_sync = [message for message in owner_socket.messages if message.get("type") == "sync_response"]
    member_sync = [message for message in member_socket.messages if message.get("type") == "sync_response"]
    assert len(owner_sync) > owner_sync_before_rename and owner_sync[-1]["household"]["name"] == "Family home"
    assert len(member_sync) > member_sync_before_rename and member_sync[-1]["household"]["name"] == "Family home"

    rename_started = threading.Event()
    allow_rename = threading.Event()
    rename_errors = []
    original_sync_user_ids = households_router._household_sync_user_ids

    def pause_rename_with_writer_lock(db, target_household_id, *additional_user_ids):
        result = original_sync_user_ids(db, target_household_id, *additional_user_ids)
        if threading.current_thread().name == "household-rename-first" and not rename_started.is_set():
            rename_started.set()
            assert allow_rename.wait(timeout=5)
        return result

    def run_rename(name):
        try:
            asyncio.run(update_household_endpoint(household_id, HouseholdUpdate(name=name), owner_id))
        except Exception as error:
            rename_errors.append(error)

    households_router._household_sync_user_ids = pause_rename_with_writer_lock
    first_rename_thread = threading.Thread(target=run_rename, args=("First serialized",), name="household-rename-first")
    second_rename_thread = threading.Thread(target=run_rename, args=("Second serialized",), name="household-rename-second")
    try:
        first_rename_thread.start()
        assert rename_started.wait(timeout=5), "rename did not reach serialized validation"
        second_rename_thread.start()
        second_rename_thread.join(timeout=0.1)
        assert second_rename_thread.is_alive(), "concurrent rename bypassed household writer serialization"
        allow_rename.set()
        first_rename_thread.join(timeout=5)
        second_rename_thread.join(timeout=5)
    finally:
        allow_rename.set()
        households_router._household_sync_user_ids = original_sync_user_ids
    assert not first_rename_thread.is_alive() and not second_rename_thread.is_alive()
    assert not rename_errors, rename_errors
    assert get_current_household(owner_id)["household"]["name"] == "Second serialized"

    try:
        asyncio.run(
            invite_household_member_endpoint(
                household_id,
                HouseholdInviteCreate(username="outsider"),
                request(),
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
            request(),
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
    assert household_project["id"] not in {project["id"] for project in outsider_sync[-1]["projects"]}
    assert outsider_sync[-1]["household"] is None
    member_sync = [message for message in member_socket.messages if message.get("type") == "sync_response"]
    assert len(member_sync) > member_sync_before_removal
    assert outsider_id not in {member["user_id"] for member in member_sync[-1]["household"]["members"]}

    pending_at_dissolution = asyncio.run(
        invite_household_member_endpoint(
            household_id,
            HouseholdInviteCreate(username="outsider"),
            request(),
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
        assert db.execute(
            "SELECT COUNT(*) AS count FROM project_members WHERE project_id = ?",
            (household_project["id"],),
        ).fetchone()["count"] == 0
    assert get_current_household(member_id)["household"] is None
    member_sync = [message for message in member_socket.messages if message.get("type") == "sync_response"]
    outsider_sync = [message for message in outsider_socket.messages if message.get("type") == "sync_response"]
    assert next(project for project in member_sync[-1]["projects"] if project["id"] == household_project["id"])["is_owner"] == 1
    assert household_project["id"] not in {project["id"] for project in outsider_sync[-1]["projects"]}
    assert outsider_sync[-1]["household_invites"] == []
    assert member_sync[-1]["household"] is None

    manager.connections.clear()

print("✅ Household API invitation and ownership lifecycle works")
