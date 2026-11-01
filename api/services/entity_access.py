"""Household ownership and shared entity permission contract."""

from dataclasses import dataclass
import sqlite3

from db import now_iso


ENTITY_TYPE_REGISTRY = frozenset({"project", "shopping_list"})
_ACTIVE_HOUSEHOLD_STATUSES = ("pending", "accepted")
_ENTITY_GRANT_STATUSES = frozenset({"pending", "accepted", "declined", "left", "removed"})


def _ensure_write_transaction(db) -> None:
    if not db.in_transaction:
        db.execute("BEGIN IMMEDIATE")


@dataclass(frozen=True)
class EntityPermissions:
    entity_exists: bool
    sources: tuple[str, ...]
    can_view: bool
    can_edit_content: bool
    can_manage_metadata: bool
    can_manage_access: bool
    can_archive: bool
    can_delete: bool


def _permissions(entity_exists: bool, sources: tuple[str, ...], *, manager: bool = False) -> EntityPermissions:
    allowed = bool(sources)
    return EntityPermissions(
        entity_exists=entity_exists,
        sources=sources,
        can_view=allowed,
        can_edit_content=allowed,
        can_manage_metadata=manager,
        can_manage_access=manager,
        can_archive=manager,
        can_delete=manager,
    )


def _normalize_entity_key(entity_type: str, entity_id: int) -> tuple[str, int]:
    normalized_type = (entity_type or "").strip()
    if normalized_type not in ENTITY_TYPE_REGISTRY:
        raise ValueError("Unsupported entity type")
    if not isinstance(entity_id, int) or isinstance(entity_id, bool) or entity_id <= 0:
        raise ValueError("Invalid entity id")
    return normalized_type, entity_id


def _require_user(db, user_id: int) -> None:
    if not db.execute("SELECT 1 FROM users WHERE id = ?", (user_id,)).fetchone():
        raise ValueError("User not found")


def _get_household(db, household_id: int):
    row = db.execute("SELECT * FROM households WHERE id = ?", (household_id,)).fetchone()
    if not row:
        raise ValueError("Household not found")
    return row


def get_entity_ownership(db, entity_type: str, entity_id: int) -> dict | None:
    entity_type, entity_id = _normalize_entity_key(entity_type, entity_id)
    row = db.execute(
        "SELECT * FROM entity_access WHERE entity_type = ? AND entity_id = ?",
        (entity_type, entity_id),
    ).fetchone()
    return dict(row) if row else None


def same_entity_owner(db, entity_type: str, first_entity_id: int, second_entity_id: int) -> bool:
    first = get_entity_ownership(db, entity_type, first_entity_id)
    second = get_entity_ownership(db, entity_type, second_entity_id)
    if not first or not second:
        return False
    return (
        first["owner_user_id"] == second["owner_user_id"]
        and first["owner_household_id"] == second["owner_household_id"]
    )


def _get_entity_access(db, entity_type: str, entity_id: int):
    entity_type, entity_id = _normalize_entity_key(entity_type, entity_id)
    row = db.execute(
        "SELECT * FROM entity_access WHERE entity_type = ? AND entity_id = ?",
        (entity_type, entity_id),
    ).fetchone()
    if not row:
        raise ValueError("Entity access not found")
    return row


def get_user_household(db, user_id: int, *, include_pending: bool = False):
    owner = db.execute(
        "SELECT h.*, 'owner' AS role, 'accepted' AS membership_status FROM households h WHERE h.owner_user_id = ?",
        (user_id,),
    ).fetchone()
    if owner:
        return owner
    statuses = _ACTIVE_HOUSEHOLD_STATUSES if include_pending else ("accepted",)
    placeholders = ",".join("?" for _ in statuses)
    return db.execute(
        f"""
        SELECT h.*, 'member' AS role, hm.status AS membership_status, hm.id AS membership_id
        FROM household_members hm
        JOIN households h ON h.id = hm.household_id
        WHERE hm.user_id = ? AND hm.status IN ({placeholders})
        ORDER BY hm.id
        LIMIT 1
        """,
        (user_id, *statuses),
    ).fetchone()


def is_household_participant(db, household_id: int, user_id: int) -> bool:
    household = db.execute(
        "SELECT owner_user_id FROM households WHERE id = ?",
        (household_id,),
    ).fetchone()
    if not household:
        return False
    if household["owner_user_id"] == user_id:
        return True
    return db.execute(
        "SELECT 1 FROM household_members WHERE household_id = ? AND user_id = ? AND status = 'accepted'",
        (household_id, user_id),
    ).fetchone() is not None


def create_household(db, name: str, owner_user_id: int) -> int:
    _ensure_write_transaction(db)
    normalized_name = (name or "").strip()
    if not normalized_name or len(normalized_name) > 120:
        raise ValueError("Invalid household name")
    _require_user(db, owner_user_id)
    if get_user_household(db, owner_user_id, include_pending=True):
        raise ValueError("User already belongs to a household")
    try:
        cursor = db.execute(
            "INSERT INTO households (name, owner_user_id, updated_at) VALUES (?, ?, ?)",
            (normalized_name, owner_user_id, now_iso()),
        )
    except sqlite3.IntegrityError as exc:
        raise ValueError("Household could not be created") from exc
    return cursor.lastrowid


def invite_household_member(db, household_id: int, actor_user_id: int, target_user_id: int) -> int:
    _ensure_write_transaction(db)
    household = _get_household(db, household_id)
    if household["owner_user_id"] != actor_user_id:
        raise PermissionError("Only the household owner can invite members")
    if target_user_id == actor_user_id:
        raise ValueError("Household owner already belongs to household")
    _require_user(db, target_user_id)
    current = get_user_household(db, target_user_id, include_pending=True)
    if current and current["id"] != household_id:
        raise ValueError("User already belongs to a household")
    existing = db.execute(
        "SELECT id, status FROM household_members WHERE household_id = ? AND user_id = ?",
        (household_id, target_user_id),
    ).fetchone()
    if existing and existing["status"] in _ACTIVE_HOUSEHOLD_STATUSES:
        raise ValueError("User already has an active household relationship")
    try:
        cursor = db.execute(
            """
            INSERT INTO household_members (
                household_id, user_id, invited_by_user_id, status, updated_at
            ) VALUES (?, ?, ?, 'pending', ?)
            ON CONFLICT(household_id, user_id) DO UPDATE SET
                invited_by_user_id = excluded.invited_by_user_id,
                status = 'pending',
                updated_at = excluded.updated_at
            """,
            (household_id, target_user_id, actor_user_id, now_iso()),
        )
    except sqlite3.IntegrityError as exc:
        raise ValueError("Household invitation could not be created") from exc
    row = db.execute(
        "SELECT id FROM household_members WHERE household_id = ? AND user_id = ?",
        (household_id, target_user_id),
    ).fetchone()
    if not row:
        raise ValueError("Household invitation could not be created")
    return row["id"]


def respond_to_household_invite(db, invite_id: int, user_id: int, *, accept: bool) -> None:
    _ensure_write_transaction(db)
    invite = db.execute(
        "SELECT * FROM household_members WHERE id = ? AND user_id = ?",
        (invite_id, user_id),
    ).fetchone()
    if not invite:
        raise ValueError("Household invitation not found")
    if invite["status"] != "pending":
        raise ValueError("Household invitation is not pending")
    status = "accepted" if accept else "declined"
    try:
        updated = db.execute(
            "UPDATE household_members SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
            (status, now_iso(), invite_id),
        )
    except sqlite3.IntegrityError as exc:
        raise ValueError("User already belongs to a household") from exc
    if updated.rowcount != 1:
        raise ValueError("Household invitation is no longer pending")


def remove_household_member(db, household_id: int, actor_user_id: int, member_user_id: int) -> None:
    _ensure_write_transaction(db)
    household = _get_household(db, household_id)
    if household["owner_user_id"] != actor_user_id:
        raise PermissionError("Only the household owner can remove members")
    updated = db.execute(
        """
        UPDATE household_members
        SET status = 'removed', updated_at = ?
        WHERE household_id = ? AND user_id = ? AND status IN ('pending', 'accepted')
        """,
        (now_iso(), household_id, member_user_id),
    )
    if updated.rowcount != 1:
        raise ValueError("Active household member not found")


def leave_household(db, household_id: int, user_id: int) -> None:
    _ensure_write_transaction(db)
    household = _get_household(db, household_id)
    if household["owner_user_id"] == user_id:
        raise ValueError("Household owner must transfer or dissolve the household")
    updated = db.execute(
        """
        UPDATE household_members
        SET status = 'left', updated_at = ?
        WHERE household_id = ? AND user_id = ? AND status = 'accepted'
        """,
        (now_iso(), household_id, user_id),
    )
    if updated.rowcount != 1:
        raise ValueError("Accepted household membership not found")


def transfer_household_ownership(db, household_id: int, actor_user_id: int, target_user_id: int) -> None:
    _ensure_write_transaction(db)
    household = _get_household(db, household_id)
    if household["owner_user_id"] != actor_user_id:
        raise PermissionError("Only the household owner can transfer ownership")
    target = db.execute(
        "SELECT id FROM household_members WHERE household_id = ? AND user_id = ? AND status = 'accepted'",
        (household_id, target_user_id),
    ).fetchone()
    if not target:
        raise ValueError("New household owner must be an accepted member")
    db.execute(
        "UPDATE household_members SET status = 'removed', updated_at = ? WHERE id = ?",
        (now_iso(), target["id"]),
    )
    db.execute(
        "UPDATE households SET owner_user_id = ?, updated_at = ? WHERE id = ?",
        (target_user_id, now_iso(), household_id),
    )
    db.execute(
        """
        INSERT INTO household_members (
            household_id, user_id, invited_by_user_id, status, updated_at
        ) VALUES (?, ?, ?, 'accepted', ?)
        ON CONFLICT(household_id, user_id) DO UPDATE SET
            invited_by_user_id = excluded.invited_by_user_id,
            status = 'accepted',
            updated_at = excluded.updated_at
        """,
        (household_id, actor_user_id, target_user_id, now_iso()),
    )


def _insert_entity_access(
    db,
    entity_type: str,
    entity_id: int,
    *,
    owner_user_id: int | None,
    owner_household_id: int | None,
) -> int:
    entity_type, entity_id = _normalize_entity_key(entity_type, entity_id)
    try:
        cursor = db.execute(
            """
            INSERT INTO entity_access (
                entity_type, entity_id, owner_user_id, owner_household_id, updated_at
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (entity_type, entity_id, owner_user_id, owner_household_id, now_iso()),
        )
    except sqlite3.IntegrityError as exc:
        raise ValueError("Entity access could not be registered") from exc
    return cursor.lastrowid


def register_personal_entity(db, entity_type: str, entity_id: int, owner_user_id: int) -> int:
    _require_user(db, owner_user_id)
    return _insert_entity_access(
        db,
        entity_type,
        entity_id,
        owner_user_id=owner_user_id,
        owner_household_id=None,
    )


def register_household_entity(
    db,
    entity_type: str,
    entity_id: int,
    actor_user_id: int,
    household_id: int,
) -> int:
    _get_household(db, household_id)
    if not is_household_participant(db, household_id, actor_user_id):
        raise PermissionError("Only household participants can create household entities")
    return _insert_entity_access(
        db,
        entity_type,
        entity_id,
        owner_user_id=None,
        owner_household_id=household_id,
    )


def transfer_entity_to_household(
    db,
    entity_type: str,
    entity_id: int,
    actor_user_id: int,
    household_id: int,
) -> None:
    access = _get_entity_access(db, entity_type, entity_id)
    if access["owner_user_id"] != actor_user_id:
        raise PermissionError("Only the personal entity owner can transfer it")
    if not is_household_participant(db, household_id, actor_user_id):
        raise PermissionError("Entity owner does not belong to household")
    db.execute(
        "DELETE FROM entity_access_grants WHERE entity_access_id = ?",
        (access["id"],),
    )
    db.execute(
        """
        UPDATE entity_access
        SET owner_user_id = NULL, owner_household_id = ?, updated_at = ?
        WHERE id = ?
        """,
        (household_id, now_iso(), access["id"]),
    )


def transfer_household_entity_to_user(
    db,
    entity_type: str,
    entity_id: int,
    actor_user_id: int,
    target_user_id: int,
) -> None:
    access = _get_entity_access(db, entity_type, entity_id)
    if access["owner_household_id"] is None:
        raise ValueError("Entity is not household-owned")
    household = _get_household(db, access["owner_household_id"])
    if household["owner_user_id"] != actor_user_id:
        raise PermissionError("Only the household owner can transfer household entities")
    if not is_household_participant(db, household["id"], target_user_id):
        raise ValueError("Target user must belong to the household")
    db.execute(
        "DELETE FROM entity_access_grants WHERE entity_access_id = ?",
        (access["id"],),
    )
    db.execute(
        """
        UPDATE entity_access
        SET owner_user_id = ?, owner_household_id = NULL, updated_at = ?
        WHERE id = ?
        """,
        (target_user_id, now_iso(), access["id"]),
    )


def _entity_manager_user_id(db, access) -> int:
    if access["owner_user_id"] is not None:
        return access["owner_user_id"]
    household = _get_household(db, access["owner_household_id"])
    return household["owner_user_id"]


def get_entity_participant_user_ids(db, entity_type: str, entity_id: int) -> set[int]:
    access = _get_entity_access(db, entity_type, entity_id)
    user_ids: set[int] = set()
    if access["owner_user_id"] is not None:
        user_ids.add(access["owner_user_id"])
    else:
        household = _get_household(db, access["owner_household_id"])
        user_ids.add(household["owner_user_id"])
        rows = db.execute(
            "SELECT user_id FROM household_members WHERE household_id = ? AND status = 'accepted'",
            (access["owner_household_id"],),
        ).fetchall()
        user_ids.update(row["user_id"] for row in rows)
    if access["owner_user_id"] is not None:
        grants = db.execute(
            """SELECT user_id FROM entity_access_grants
               WHERE entity_access_id = ? AND status = 'accepted'""",
            (access["id"],),
        ).fetchall()
        user_ids.update(row["user_id"] for row in grants)
    return user_ids


def _entity_grant_row(db, entity_type: str, entity_id: int, user_id: int):
    access = _get_entity_access(db, entity_type, entity_id)
    return db.execute(
        "SELECT * FROM entity_access_grants WHERE entity_access_id = ? AND user_id = ?",
        (access["id"], user_id),
    ).fetchone()


def grant_entity_access(
    db,
    entity_type: str,
    entity_id: int,
    actor_user_id: int,
    target_user_id: int,
) -> None:
    """Compatibility helper for trusted immediate grants."""
    _ensure_write_transaction(db)
    access = _get_entity_access(db, entity_type, entity_id)
    if _entity_manager_user_id(db, access) != actor_user_id:
        raise PermissionError("Only the entity manager can grant access")
    if access["owner_household_id"] is not None:
        raise ValueError("Household entities cannot be shared directly")
    if target_user_id == actor_user_id:
        raise ValueError("Entity manager already has access")
    _require_user(db, target_user_id)
    db.execute(
        """
        INSERT INTO entity_access_grants (
            entity_access_id, user_id, invited_by_user_id, granted_by_user_id, status, updated_at
        ) VALUES (?, ?, ?, ?, 'accepted', ?)
        ON CONFLICT(entity_access_id, user_id) DO UPDATE SET
            invited_by_user_id = excluded.invited_by_user_id,
            granted_by_user_id = excluded.granted_by_user_id,
            status = 'accepted',
            updated_at = excluded.updated_at
        """,
        (access["id"], target_user_id, actor_user_id, actor_user_id, now_iso()),
    )


def invite_entity_access(
    db,
    entity_type: str,
    entity_id: int,
    actor_user_id: int,
    target_user_id: int,
    *,
    invite_identifier_type: str | None = None,
) -> dict:
    """Create or re-open a pending direct invitation without granting access."""
    _ensure_write_transaction(db)
    access = _get_entity_access(db, entity_type, entity_id)
    if _entity_manager_user_id(db, access) != actor_user_id:
        raise PermissionError("Only the entity manager can invite users")
    if access["owner_household_id"] is not None:
        raise ValueError("Household entities cannot be shared directly")
    if target_user_id == actor_user_id:
        raise ValueError("Entity manager already has access")
    if invite_identifier_type not in (None, "username", "email"):
        raise ValueError("Invalid invite identifier type")
    _require_user(db, target_user_id)
    existing = _entity_grant_row(db, entity_type, entity_id, target_user_id)
    if existing and existing["status"] in ("pending", "accepted"):
        raise ValueError("User already has access or a pending invite")
    db.execute(
        """
        INSERT INTO entity_access_grants (
            entity_access_id, user_id, invited_by_user_id, granted_by_user_id,
            invite_identifier_type, status, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
        ON CONFLICT(entity_access_id, user_id) DO UPDATE SET
            invited_by_user_id = excluded.invited_by_user_id,
            granted_by_user_id = excluded.granted_by_user_id,
            invite_identifier_type = excluded.invite_identifier_type,
            status = 'pending',
            updated_at = excluded.updated_at
        """,
        (access["id"], target_user_id, actor_user_id, actor_user_id, invite_identifier_type, now_iso()),
    )
    return dict(_entity_grant_row(db, entity_type, entity_id, target_user_id))


def respond_to_entity_invite(
    db,
    entity_type: str,
    entity_id: int,
    invite_id: int,
    user_id: int,
    *,
    accept: bool,
) -> dict:
    """CAS-transition a recipient's pending invitation."""
    _ensure_write_transaction(db)
    access = _get_entity_access(db, entity_type, entity_id)
    new_status = "accepted" if accept else "declined"
    updated = db.execute(
        """UPDATE entity_access_grants
           SET status = ?, updated_at = ?
           WHERE id = ? AND entity_access_id = ? AND user_id = ? AND status = 'pending'""",
        (new_status, now_iso(), invite_id, access["id"], user_id),
    )
    if updated.rowcount != 1:
        raise ValueError("Entity invitation is no longer pending")
    row = db.execute("SELECT * FROM entity_access_grants WHERE id = ?", (invite_id,)).fetchone()
    return dict(row)


def remove_entity_access(
    db,
    entity_type: str,
    entity_id: int,
    actor_user_id: int,
    target_user_id: int,
) -> dict:
    """CAS-remove a pending or accepted direct participant."""
    _ensure_write_transaction(db)
    access = _get_entity_access(db, entity_type, entity_id)
    if _entity_manager_user_id(db, access) != actor_user_id:
        raise PermissionError("Only the entity manager can remove access")
    updated = db.execute(
        """UPDATE entity_access_grants
           SET status = 'removed', updated_at = ?
           WHERE entity_access_id = ? AND user_id = ? AND status IN ('pending', 'accepted')""",
        (now_iso(), access["id"], target_user_id),
    )
    if updated.rowcount != 1:
        raise ValueError("Active entity participant not found")
    return dict(_entity_grant_row(db, entity_type, entity_id, target_user_id))


def restore_entity_access(
    db,
    entity_type: str,
    entity_id: int,
    actor_user_id: int,
    target_user_id: int,
    *,
    status: str = "accepted",
) -> dict:
    """Restore an inactive grant; recipients may only undo their own leave."""
    _ensure_write_transaction(db)
    if status not in ("pending", "accepted"):
        raise ValueError("Invalid restore status")
    access = _get_entity_access(db, entity_type, entity_id)
    grant = _entity_grant_row(db, entity_type, entity_id, target_user_id)
    if not grant:
        raise ValueError("Entity participant not found")
    manager = _entity_manager_user_id(db, access)
    if actor_user_id == target_user_id:
        if grant["status"] != "left" or status != "accepted":
            raise PermissionError("Recipients can only undo their own leave")
        expected = ("left",)
    elif actor_user_id == manager:
        if grant["status"] in ("left", "declined") and status != "pending":
            raise PermissionError(f"A {grant['status']} recipient must accept a new invitation")
        expected = (grant["status"],) if grant["status"] in ("removed", "left", "declined") else ()
    else:
        raise PermissionError("Only the entity manager or recipient can restore access")
    if not expected:
        raise ValueError("Entity participant state changed")
    placeholders = ",".join("?" for _ in expected)
    updated = db.execute(
        f"""UPDATE entity_access_grants
            SET status = ?, invited_by_user_id = ?, granted_by_user_id = ?, updated_at = ?
            WHERE id = ? AND status IN ({placeholders})""",
        (status, manager, manager, now_iso(), grant["id"], *expected),
    )
    if updated.rowcount != 1:
        raise ValueError("Entity participant state changed")
    return dict(_entity_grant_row(db, entity_type, entity_id, target_user_id))


def list_entity_access_members(
    db,
    entity_type: str,
    entity_id: int,
    *,
    include_inactive: bool = False,
) -> list[dict]:
    access = _get_entity_access(db, entity_type, entity_id)
    statuses = _ENTITY_GRANT_STATUSES if include_inactive else frozenset({"pending", "accepted"})
    placeholders = ",".join("?" for _ in statuses)
    rows = db.execute(
        f"""SELECT grant_row.*, user.username, user.display_name
            FROM entity_access_grants grant_row
            JOIN users user ON user.id = grant_row.user_id
            WHERE grant_row.entity_access_id = ? AND grant_row.status IN ({placeholders})
            ORDER BY CASE grant_row.status WHEN 'accepted' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
                     lower(COALESCE(user.display_name, user.username)), user.id""",
        (access["id"], *sorted(statuses)),
    ).fetchall()
    return [dict(row) for row in rows]


def list_entity_access_invites(db, user_id: int, entity_type: str | None = None) -> list[dict]:
    params: list[object] = [user_id]
    type_clause = ""
    if entity_type is not None:
        normalized_type, _ = _normalize_entity_key(entity_type, 1)
        type_clause = " AND access.entity_type = ?"
        params.append(normalized_type)
    rows = db.execute(
        f"""SELECT grant_row.*, access.entity_type, access.entity_id,
                   inviter.username AS invited_by_username,
                   inviter.display_name AS invited_by_display_name
            FROM entity_access_grants grant_row
            JOIN entity_access access ON access.id = grant_row.entity_access_id
            LEFT JOIN users inviter ON inviter.id = grant_row.invited_by_user_id
            WHERE grant_row.user_id = ? AND grant_row.status = 'pending'
              AND access.owner_household_id IS NULL{type_clause}
            ORDER BY grant_row.created_at, grant_row.id""",
        params,
    ).fetchall()
    return [dict(row) for row in rows]


def get_entity_access_boundary_user_ids(db, entity_type: str, entity_id: int) -> set[int]:
    """Return current participants plus pending invitees for boundary refreshes."""
    access = _get_entity_access(db, entity_type, entity_id)
    users = get_entity_participant_user_ids(db, entity_type, entity_id)
    rows = db.execute(
        """SELECT user_id FROM entity_access_grants
           WHERE entity_access_id = ? AND status IN ('pending', 'accepted')""",
        (access["id"],),
    ).fetchall()
    users.update(row["user_id"] for row in rows)
    return users


def revoke_entity_access(
    db,
    entity_type: str,
    entity_id: int,
    actor_user_id: int,
    target_user_id: int,
) -> None:
    """Compatibility wrapper for manager removal."""
    remove_entity_access(db, entity_type, entity_id, actor_user_id, target_user_id)


def leave_entity_access(db, entity_type: str, entity_id: int, user_id: int) -> None:
    """CAS-transition the caller's accepted direct grant to left."""
    _ensure_write_transaction(db)
    access = _get_entity_access(db, entity_type, entity_id)
    if _entity_manager_user_id(db, access) == user_id:
        raise ValueError("Entity manager cannot leave their own entity")
    updated = db.execute(
        """UPDATE entity_access_grants SET status = 'left', updated_at = ?
           WHERE entity_access_id = ? AND user_id = ? AND status = 'accepted'""",
        (now_iso(), access["id"], user_id),
    )
    if updated.rowcount != 1:
        raise PermissionError("User has no direct access grant")


def resolve_entity_access(db, entity_type: str, entity_id: int, user_id: int) -> EntityPermissions:
    entity_type, entity_id = _normalize_entity_key(entity_type, entity_id)
    access = db.execute(
        "SELECT * FROM entity_access WHERE entity_type = ? AND entity_id = ?",
        (entity_type, entity_id),
    ).fetchone()
    if not access:
        return _permissions(False, ())

    if access["owner_user_id"] == user_id:
        return _permissions(True, ("owner",), manager=True)

    if access["owner_household_id"] is not None:
        household = _get_household(db, access["owner_household_id"])
        if household["owner_user_id"] == user_id:
            return _permissions(True, ("household_owner",), manager=True)

    sources = []
    if access["owner_household_id"] is not None and is_household_participant(
        db, access["owner_household_id"], user_id
    ):
        sources.append("household")
    if access["owner_household_id"] is None and db.execute(
        """SELECT 1 FROM entity_access_grants
           WHERE entity_access_id = ? AND user_id = ? AND status = 'accepted'""",
        (access["id"], user_id),
    ).fetchone():
        sources.append("direct")
    return _permissions(True, tuple(sources))
