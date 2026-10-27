"""Household ownership and shared entity permission contract."""

from dataclasses import dataclass
import re
import sqlite3

from db import now_iso


_ENTITY_TYPE_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_ACTIVE_HOUSEHOLD_STATUSES = ("pending", "accepted")


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
    if not _ENTITY_TYPE_RE.fullmatch(normalized_type):
        raise ValueError("Invalid entity type")
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
            "SELECT user_id FROM entity_access_grants WHERE entity_access_id = ?",
            (access["id"],),
        ).fetchall()
        user_ids.update(row["user_id"] for row in grants)
    return user_ids


def grant_entity_access(
    db,
    entity_type: str,
    entity_id: int,
    actor_user_id: int,
    target_user_id: int,
) -> None:
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
        INSERT INTO entity_access_grants (entity_access_id, user_id, granted_by_user_id)
        VALUES (?, ?, ?)
        ON CONFLICT(entity_access_id, user_id) DO NOTHING
        """,
        (access["id"], target_user_id, actor_user_id),
    )


def revoke_entity_access(
    db,
    entity_type: str,
    entity_id: int,
    actor_user_id: int,
    target_user_id: int,
) -> None:
    access = _get_entity_access(db, entity_type, entity_id)
    if _entity_manager_user_id(db, access) != actor_user_id:
        raise PermissionError("Only the entity manager can revoke access")
    db.execute(
        "DELETE FROM entity_access_grants WHERE entity_access_id = ? AND user_id = ?",
        (access["id"], target_user_id),
    )


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
        "SELECT 1 FROM entity_access_grants WHERE entity_access_id = ? AND user_id = ?",
        (access["id"], user_id),
    ).fetchone():
        sources.append("direct")
    return _permissions(True, tuple(sources))
