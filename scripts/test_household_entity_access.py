#!/usr/bin/env python3
"""Households own shared entities and expose one permission contract."""

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
        create_household,
        grant_entity_access,
        invite_household_member,
        register_household_entity,
        register_personal_entity,
        remove_household_member,
        resolve_entity_access,
        respond_to_household_invite,
        revoke_entity_access,
        transfer_entity_to_household,
        transfer_household_entity_to_user,
        transfer_household_ownership,
    )

    run_migrations()

    with get_db() as db:
        owner_id = db.execute("INSERT INTO users (username) VALUES ('owner')").lastrowid
        member_id = db.execute("INSERT INTO users (username) VALUES ('member')").lastrowid
        outsider_id = db.execute("INSERT INTO users (username) VALUES ('outsider')").lastrowid
        other_id = db.execute("INSERT INTO users (username) VALUES ('other')").lastrowid
        db.commit()

        household_id = create_household(db, "Home", owner_id)

        try:
            create_household(db, "Second", owner_id)
        except ValueError:
            pass
        else:
            raise AssertionError("user created a second household")

        invite_id = invite_household_member(db, household_id, owner_id, member_id)
        pending = db.execute("SELECT status FROM household_members WHERE id = ?", (invite_id,)).fetchone()
        assert pending["status"] == "pending", pending

        try:
            create_household(db, "Member household", member_id)
        except ValueError:
            pass
        else:
            raise AssertionError("user with a pending invite created another household")

        register_household_entity(db, "shopping_list", 41, owner_id, household_id)
        assert resolve_entity_access(db, "shopping_list", 41, member_id).sources == ()

        respond_to_household_invite(db, invite_id, member_id, accept=True)
        member = resolve_entity_access(db, "shopping_list", 41, member_id)
        assert member.sources == ("household",), member
        assert member.can_view and member.can_edit_content, member
        assert not member.can_manage_metadata and not member.can_manage_access, member
        assert not member.can_archive and not member.can_delete, member

        household_owner = resolve_entity_access(db, "shopping_list", 41, owner_id)
        assert household_owner.sources == ("household_owner",), household_owner
        assert household_owner.can_view and household_owner.can_edit_content, household_owner
        assert household_owner.can_manage_metadata and household_owner.can_manage_access, household_owner
        assert household_owner.can_archive and household_owner.can_delete, household_owner

        # Any accepted member may create an entity owned by the household.
        register_household_entity(db, "shopping_list", 42, member_id, household_id)
        access_row = db.execute(
            "SELECT owner_user_id, owner_household_id FROM entity_access WHERE entity_type = 'shopping_list' AND entity_id = 42"
        ).fetchone()
        assert access_row["owner_user_id"] is None, access_row
        assert access_row["owner_household_id"] == household_id, access_row

        # A personal entity becomes household-owned when moved into the household.
        register_personal_entity(db, "project", 7, member_id)
        personal = resolve_entity_access(db, "project", 7, member_id)
        assert personal.sources == ("owner",), personal
        assert personal.can_manage_access, personal

        transfer_entity_to_household(db, "project", 7, member_id, household_id)
        transferred_member = resolve_entity_access(db, "project", 7, member_id)
        assert transferred_member.sources == ("household",), transferred_member
        assert transferred_member.can_edit_content and not transferred_member.can_manage_access, transferred_member
        assert resolve_entity_access(db, "project", 7, owner_id).sources == ("household_owner",)

        # Household membership and direct sharing are independent access sources.
        grant_entity_access(db, "project", 7, owner_id, member_id)
        additive = resolve_entity_access(db, "project", 7, member_id)
        assert additive.sources == ("household", "direct"), additive

        grant_entity_access(db, "project", 7, owner_id, outsider_id)
        direct = resolve_entity_access(db, "project", 7, outsider_id)
        assert direct.sources == ("direct",), direct
        assert direct.can_view and direct.can_edit_content, direct
        assert not direct.can_manage_access and not direct.can_delete, direct

        try:
            grant_entity_access(db, "project", 7, member_id, other_id)
        except PermissionError:
            pass
        else:
            raise AssertionError("ordinary household member granted entity access")

        remove_household_member(db, household_id, owner_id, member_id)
        assert resolve_entity_access(db, "shopping_list", 42, member_id).sources == ()
        assert resolve_entity_access(db, "project", 7, member_id).sources == ("direct",)
        assert resolve_entity_access(db, "project", 7, outsider_id).sources == ("direct",)

        second_invite_id = invite_household_member(db, household_id, owner_id, member_id)
        respond_to_household_invite(db, second_invite_id, member_id, accept=True)
        transfer_household_ownership(db, household_id, owner_id, member_id)

        assert resolve_entity_access(db, "project", 7, member_id).sources == ("household_owner",)
        old_owner = resolve_entity_access(db, "project", 7, owner_id)
        assert old_owner.sources == ("household",), old_owner
        assert old_owner.can_edit_content and not old_owner.can_manage_access, old_owner

        # A household entity can only become personal through an explicit transfer.
        transfer_household_entity_to_user(db, "project", 7, member_id, owner_id)
        personal_again = resolve_entity_access(db, "project", 7, owner_id)
        assert personal_again.sources == ("owner",), personal_again
        assert personal_again.can_manage_metadata and personal_again.can_delete, personal_again
        assert resolve_entity_access(db, "project", 7, member_id).sources == ("direct",)

        revoke_entity_access(db, "project", 7, owner_id, member_id)
        assert resolve_entity_access(db, "project", 7, member_id).sources == ()
        revoke_entity_access(db, "project", 7, owner_id, outsider_id)
        assert resolve_entity_access(db, "project", 7, outsider_id).sources == ()

print("✅ Household ownership and entity permissions are explicit and stable")
