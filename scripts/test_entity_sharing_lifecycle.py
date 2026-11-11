#!/usr/bin/env python3
"""Generic entity sharing is the sole persistent access lifecycle authority."""

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
    from services.entity_access import (
        get_entity_access_boundary_user_ids,
        invite_entity_access,
        leave_entity_access,
        list_entity_access_invites,
        list_entity_access_members,
        register_personal_entity,
        remove_entity_access,
        resolve_entity_access,
        respond_to_entity_invite,
        restore_entity_access,
    )

    run_migrations()

    with get_db() as db:
        owner_id = db.execute("INSERT INTO users (username) VALUES ('owner')").lastrowid
        invitee_id = db.execute("INSERT INTO users (username) VALUES ('invitee')").lastrowid
        outsider_id = db.execute("INSERT INTO users (username) VALUES ('outsider')").lastrowid
        project_id = db.execute(
            "INSERT INTO projects (name, user_id) VALUES ('Shared project', ?)",
            (owner_id,),
        ).lastrowid
        register_personal_entity(db, "project", project_id, owner_id)
        db.commit()

        columns = {row["name"] for row in db.execute("PRAGMA table_info(entity_access_grants)")}
        assert {
            "id",
            "status",
            "invited_by_user_id",
            "invite_identifier_type",
            "updated_at",
        }.issubset(columns), columns

        invite = invite_entity_access(
            db,
            "project",
            project_id,
            owner_id,
            invitee_id,
            invite_identifier_type="username",
        )
        assert invite["status"] == "pending", invite
        assert resolve_entity_access(db, "project", project_id, invitee_id).can_view is False
        assert get_entity_access_boundary_user_ids(db, "project", project_id) == {owner_id, invitee_id}
        assert [row["id"] for row in list_entity_access_invites(db, invitee_id)] == [invite["id"]]
        assert [row["status"] for row in list_entity_access_members(db, "project", project_id)] == ["pending"]

        respond_to_entity_invite(db, "project", project_id, invite["id"], invitee_id, accept=True)
        assert resolve_entity_access(db, "project", project_id, invitee_id).sources == ("direct",)
        assert [row["status"] for row in list_entity_access_members(db, "project", project_id)] == ["accepted"]

        try:
            respond_to_entity_invite(db, "project", project_id, invite["id"], invitee_id, accept=False)
        except ValueError as exc:
            assert "no longer pending" in str(exc).lower(), exc
        else:
            raise AssertionError("accepted invite was transitioned a second time")

        leave_entity_access(db, "project", project_id, invitee_id)
        assert resolve_entity_access(db, "project", project_id, invitee_id).can_view is False
        try:
            restore_entity_access(db, "project", project_id, owner_id, invitee_id, status="accepted")
        except PermissionError as exc:
            assert "left" in str(exc).lower(), exc
        else:
            raise AssertionError("manager reactivated a voluntarily left recipient without consent")
        restore_entity_access(db, "project", project_id, invitee_id, invitee_id, status="accepted")
        assert resolve_entity_access(db, "project", project_id, invitee_id).can_view is True

        remove_entity_access(db, "project", project_id, owner_id, invitee_id)
        assert resolve_entity_access(db, "project", project_id, invitee_id).can_view is False
        try:
            restore_entity_access(db, "project", project_id, invitee_id, invitee_id, status="accepted")
        except PermissionError as exc:
            assert "own leave" in str(exc).lower(), exc
        else:
            raise AssertionError("removed recipient restored their own access")
        restore_entity_access(db, "project", project_id, owner_id, invitee_id, status="accepted")
        assert resolve_entity_access(db, "project", project_id, invitee_id).can_view is True

        remove_entity_access(db, "project", project_id, owner_id, invitee_id)
        restore_entity_access(db, "project", project_id, owner_id, invitee_id, status="pending")
        declined = db.execute(
            "SELECT id FROM entity_access_grants WHERE entity_access_id = ? AND user_id = ?",
            (invite["entity_access_id"], invitee_id),
        ).fetchone()
        respond_to_entity_invite(db, "project", project_id, declined["id"], invitee_id, accept=False)
        try:
            restore_entity_access(db, "project", project_id, owner_id, invitee_id, status="accepted")
        except PermissionError as exc:
            assert "declined" in str(exc).lower(), exc
        else:
            raise AssertionError("manager accepted a declined invitation without recipient consent")
        restore_entity_access(db, "project", project_id, owner_id, invitee_id, status="pending")
        assert resolve_entity_access(db, "project", project_id, invitee_id).can_view is False

        try:
            invite_entity_access(db, "todo", 1, owner_id, outsider_id)
        except ValueError as exc:
            assert "unsupported entity type" in str(exc).lower(), exc
        else:
            raise AssertionError("unregistered entity type was shareable")


print("✅ Generic entity sharing lifecycle is persistent, pending-safe and CAS-protected")
