#!/usr/bin/env python3
"""Project and Shopping adapters delegate authorization to generic entity sharing."""

import asyncio
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

with tempfile.TemporaryDirectory() as tmp:
    os.environ["NIA_TODO_DATA_DIR"] = tmp
    sys.path.insert(0, str(ROOT / "api"))

    from fastapi import HTTPException
    from starlette.requests import Request
    from db import get_db
    from migrate import run_migrations
    from routers.admin import delete_user
    from routers.households import HouseholdInviteCreate, invite_household_member_endpoint
    from routers.projects import ProjectUpdate, update_project
    from routers.shopping import (
        ShoppingListCreate,
        ShoppingListShareCreate,
        create_shopping_list,
        list_shopping_list_members,
        list_shopping_lists,
        share_shopping_list,
    )
    import services.websocket as websocket_service
    from services.entity_access import (
        create_household,
        grant_entity_access,
        register_personal_entity,
        respond_to_entity_invite,
    )
    from services.sharing import can_access_project

    run_migrations()

    with get_db() as db:
        owner_id = db.execute("INSERT INTO users (username) VALUES ('owner')").lastrowid
        accept_id = db.execute("INSERT INTO users (username) VALUES ('accept-me')").lastrowid
        decline_id = db.execute("INSERT INTO users (username) VALUES ('decline-me')").lastrowid
        legacy_id = db.execute("INSERT INTO users (username) VALUES ('legacy-only')").lastrowid
        generic_id = db.execute("INSERT INTO users (username) VALUES ('generic-only')").lastrowid
        outsider_id = db.execute("INSERT INTO users (username) VALUES ('outsider')").lastrowid
        generic_workspace_id = db.execute(
            "INSERT INTO workspaces (name, user_id, is_default) VALUES ('Generic display', ?, 1)",
            (generic_id,),
        ).lastrowid
        project_id = db.execute(
            "INSERT INTO projects (name, user_id) VALUES ('Authority', ?)",
            (owner_id,),
        ).lastrowid
        register_personal_entity(db, "project", project_id, owner_id)
        child_project_id = db.execute(
            "INSERT INTO projects (name, user_id, parent_id) VALUES ('Inherited child', ?, ?)",
            (owner_id, project_id),
        ).lastrowid
        register_personal_entity(db, "project", child_project_id, owner_id)
        db.execute(
            """INSERT INTO project_members (project_id, user_id, invited_by, status)
               VALUES (?, ?, ?, 'accepted')""",
            (project_id, legacy_id, owner_id),
        )
        grant_entity_access(db, "project", project_id, owner_id, generic_id)
        db.execute(
            """INSERT INTO project_members (project_id, user_id, invited_by, status)
               VALUES (?, ?, ?, 'removed')""",
            (project_id, generic_id, owner_id),
        )
        db.commit()
        assert can_access_project(db, project_id, legacy_id) is False
        assert can_access_project(db, project_id, generic_id) is True

    request = Request({'type': 'http', 'method': 'POST', 'path': '/', 'headers': [], 'scheme': 'http', 'server': ('test', 80), 'client': ('127.0.0.1', 1), 'query_string': b''})
    with get_db() as db:
        household_id = create_household(db, 'Private household', owner_id)
        db.commit()
    for identifier in ('accept-me', 'missing-user'):
        try:
            asyncio.run(invite_household_member_endpoint(
                household_id,
                HouseholdInviteCreate(username=identifier),
                request,
                outsider_id,
            ))
        except HTTPException as error:
            assert error.status_code == 403, (identifier, error.status_code, error.detail)
        else:
            raise AssertionError(f'household outsider enumerated account through {identifier!r}')

    asyncio.run(
        update_project(
            project_id,
            ProjectUpdate(workspace_id=generic_workspace_id),
            generic_id,
        )
    )
    with get_db() as db:
        generic_preferences = db.execute(
            "SELECT workspace_id FROM project_members WHERE project_id = ? AND user_id = ?",
            (project_id, generic_id),
        ).fetchone()
        legacy_preferences = db.execute(
            "SELECT workspace_id FROM project_members WHERE project_id = ? AND user_id = ?",
            (project_id, legacy_id),
        ).fetchone()
        assert generic_preferences["workspace_id"] == generic_workspace_id, generic_preferences
        assert legacy_preferences["workspace_id"] is None, legacy_preferences

    asyncio.run(
        update_project(
            child_project_id,
            ProjectUpdate(workspace_id=generic_workspace_id),
            generic_id,
        )
    )
    with get_db() as db:
        assert db.execute(
            "SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?",
            (child_project_id, generic_id),
        ).fetchone() is None, 'inherited display preferences must not create an accepted child membership mirror'

    account_delete_payloads = {}
    original_broadcast_to_user = websocket_service.manager.broadcast_to_user

    async def capture_account_delete(user_id, message):
        account_delete_payloads.setdefault(user_id, []).append(message)
        return True

    websocket_service.manager.broadcast_to_user = capture_account_delete
    try:
        asyncio.run(delete_user(generic_id, True))
    finally:
        websocket_service.manager.broadcast_to_user = original_broadcast_to_user
    assert any(
        message.get("type") == "sync_response"
        for message in account_delete_payloads.get(owner_id, [])
    ), account_delete_payloads

    shopping_list = asyncio.run(
        create_shopping_list(ShoppingListCreate(name="Pending share"), owner_id)
    )
    accepted_invite = asyncio.run(
        share_shopping_list(
            shopping_list["id"],
            ShoppingListShareCreate(identifier="accept-me"),
            None,
            owner_id,
        )
    )
    assert accepted_invite["status"] == "pending", accepted_invite
    assert list_shopping_lists(accept_id)["shopping_lists"] == []
    members = list_shopping_list_members(shopping_list["id"], owner_id)["members"]
    assert [(row["user_id"], row["status"]) for row in members] == [(accept_id, "pending")], members

    with get_db() as db:
        respond_to_entity_invite(
            db,
            "shopping_list",
            shopping_list["id"],
            accepted_invite["id"],
            accept_id,
            accept=True,
        )
        db.commit()
    assert [row["id"] for row in list_shopping_lists(accept_id)["shopping_lists"]] == [shopping_list["id"]]

    shopping_delete_payloads = {}

    async def capture_shopping_account_delete(user_id, message):
        shopping_delete_payloads.setdefault(user_id, []).append(message)
        return True

    websocket_service.manager.broadcast_to_user = capture_shopping_account_delete
    try:
        asyncio.run(delete_user(accept_id, True))
    finally:
        websocket_service.manager.broadcast_to_user = original_broadcast_to_user
    assert any(
        message.get("type") == "sync_response"
        for message in shopping_delete_payloads.get(owner_id, [])
    ), shopping_delete_payloads


    declined_invite = asyncio.run(
        share_shopping_list(
            shopping_list["id"],
            ShoppingListShareCreate(identifier="decline-me"),
            None,
            owner_id,
        )
    )
    with get_db() as db:
        respond_to_entity_invite(
            db,
            "shopping_list",
            shopping_list["id"],
            declined_invite["id"],
            decline_id,
            accept=False,
        )
        db.commit()
    assert list_shopping_lists(decline_id)["shopping_lists"] == []

    project_router_source = (ROOT / "api" / "routers" / "sharing.py").read_text(encoding="utf-8")
    shopping_router_source = (ROOT / "api" / "routers" / "shopping.py").read_text(encoding="utf-8")
    for source in (project_router_source, shopping_router_source):
        assert "notify_entity_share_invite" in source, "domain adapter bypasses generic share notification"
        assert "entity_share_invite_email(" not in source, "domain adapter owns a parallel email template path"
        assert "send_email(" not in source, "domain adapter owns a parallel SMTP path"

print("✅ Project and Shopping adapters use generic pending/accepted authority")
