#!/usr/bin/env python3
"""Generic entity-sharing HTTP lifecycle is registered for supported entities."""

import os
import sys
import tempfile
import inspect
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

with tempfile.TemporaryDirectory() as tmp:
    os.environ["NIA_TODO_DATA_DIR"] = tmp
    sys.path.insert(0, str(ROOT / "api"))

    from routers.entity_sharing import (
        invite_entity_member,
        leave_entity,
        list_entity_members,
        remove_entity_member,
        respond_to_invite,
        restore_entity_member,
        router as entity_router,
    )
    from routers.shopping import respond_to_shopping_list_invite, router as shopping_router

    routes = {
        (method, route.path)
        for router in (entity_router, shopping_router)
        for route in router.routes
        for method in getattr(route, "methods", set())
    }
    expected = {
        ("GET", "/api/entity-sharing/invites"),
        ("GET", "/api/entity-sharing/{entity_type}/{entity_id}/members"),
        ("POST", "/api/entity-sharing/{entity_type}/{entity_id}/invites"),
        ("POST", "/api/entity-sharing/{entity_type}/{entity_id}/invites/{invite_id}"),
        ("DELETE", "/api/entity-sharing/{entity_type}/{entity_id}/members/{member_user_id}"),
        ("POST", "/api/entity-sharing/{entity_type}/{entity_id}/leave"),
        ("POST", "/api/entity-sharing/{entity_type}/{entity_id}/members/{member_user_id}/restore"),
        ("POST", "/api/shopping/lists/{shopping_list_id}/invites/{invite_id}"),
    }
    missing = expected - routes
    assert not missing, missing
    member_source = inspect.getsource(list_entity_members)
    assert "manage=True" in member_source, member_source
    assert "invited_by_user_id" not in member_source, member_source
    assert "granted_by_user_id" not in member_source, member_source
    for endpoint in (
        invite_entity_member,
        respond_to_invite,
        remove_entity_member,
        leave_entity,
        restore_entity_member,
    ):
        source = inspect.getsource(endpoint)
        assert "_sync_project_member_status" in source, endpoint.__name__
    assert "grant_row.status = 'pending'" in inspect.getsource(respond_to_invite)
    assert "grant_row.status = 'pending'" in inspect.getsource(respond_to_shopping_list_invite)

print("✅ Generic entity-sharing HTTP lifecycle is registered")
