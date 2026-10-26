"""Household lifecycle endpoints."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from db import get_db
from routers.auth import require_auth
from routers.sharing import get_user_by_identifier
from routers.websocket import broadcast_sync_to_users
from services.entity_access import (
    create_household,
    get_user_household,
    invite_household_member,
    leave_household,
    remove_household_member,
    respond_to_household_invite,
    transfer_household_ownership,
)
from services.sharing import get_project_participant_user_ids


router = APIRouter(prefix="/api/households")


def _household_sync_user_ids(db, household_id: int, *additional_user_ids: int) -> set[int]:
    household = db.execute("SELECT owner_user_id FROM households WHERE id = ?", (household_id,)).fetchone()
    user_ids = {candidate for candidate in additional_user_ids if candidate is not None}
    if household:
        user_ids.add(household["owner_user_id"])
    rows = db.execute(
        "SELECT user_id FROM household_members WHERE household_id = ? AND status IN ('pending', 'accepted')",
        (household_id,),
    ).fetchall()
    user_ids.update(row["user_id"] for row in rows)
    return user_ids


class HouseholdCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)


class HouseholdInviteCreate(BaseModel):
    username: str = Field(..., min_length=3, max_length=254)


class HouseholdInviteResponse(BaseModel):
    accept: bool


class HouseholdOwnerTransfer(BaseModel):
    user_id: int = Field(..., gt=0)


def _household_view(db, household_id: int, viewer_user_id: int) -> dict:
    household = db.execute(
        """
        SELECT h.*, u.username AS owner_username, u.display_name AS owner_display_name
        FROM households h
        JOIN users u ON u.id = h.owner_user_id
        WHERE h.id = ?
        """,
        (household_id,),
    ).fetchone()
    if not household:
        raise HTTPException(404, "Household not found")
    role = "owner" if household["owner_user_id"] == viewer_user_id else "member"
    result = dict(household)
    result["role"] = role
    if role == "owner":
        rows = db.execute(
            """
            SELECT hm.id, hm.user_id, hm.status, hm.created_at, hm.updated_at,
                   u.username, u.display_name
            FROM household_members hm
            JOIN users u ON u.id = hm.user_id
            WHERE hm.household_id = ? AND hm.status IN ('pending', 'accepted')
            ORDER BY CASE hm.status WHEN 'accepted' THEN 0 ELSE 1 END, u.username
            """,
            (household_id,),
        ).fetchall()
    else:
        rows = db.execute(
            """
            SELECT hm.id, hm.user_id, hm.status, hm.created_at, hm.updated_at,
                   u.username, u.display_name
            FROM household_members hm
            JOIN users u ON u.id = hm.user_id
            WHERE hm.household_id = ? AND hm.status = 'accepted'
            ORDER BY u.username
            """,
            (household_id,),
        ).fetchall()
    result["members"] = [dict(row) for row in rows]
    return result


@router.get("/current")
def get_current_household(user_id: int = Depends(require_auth)):
    with get_db() as db:
        household = get_user_household(db, user_id)
        if not household:
            return {"household": None}
        return {"household": _household_view(db, household["id"], user_id)}


@router.get("/invites")
def list_household_invites(user_id: int = Depends(require_auth)):
    with get_db() as db:
        rows = db.execute(
            """
            SELECT hm.id, hm.household_id, hm.status, hm.created_at, hm.updated_at,
                   h.name AS household_name,
                   u.username AS invited_by_username,
                   u.display_name AS invited_by_display_name
            FROM household_members hm
            JOIN households h ON h.id = hm.household_id
            LEFT JOIN users u ON u.id = hm.invited_by_user_id
            WHERE hm.user_id = ? AND hm.status = 'pending'
            ORDER BY hm.created_at, hm.id
            """,
            (user_id,),
        ).fetchall()
        return {"invites": [dict(row) for row in rows]}


@router.post("")
async def create_household_endpoint(data: HouseholdCreate, user_id: int = Depends(require_auth)):
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        try:
            household_id = create_household(db, data.name, user_id)
            db.commit()
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        return {"household": _household_view(db, household_id, user_id)}


@router.post("/{household_id}/invites")
async def invite_household_member_endpoint(
    household_id: int,
    data: HouseholdInviteCreate,
    user_id: int = Depends(require_auth),
):
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        target = get_user_by_identifier(db, data.username.strip())
        if not target:
            raise HTTPException(404, "User not found")
        try:
            invite_id = invite_household_member(db, household_id, user_id, target["id"])
            db.commit()
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        invite = db.execute(
            """
            SELECT hm.id, hm.household_id, hm.user_id, hm.status, hm.created_at, hm.updated_at,
                   u.username, u.display_name
            FROM household_members hm
            JOIN users u ON u.id = hm.user_id
            WHERE hm.id = ?
            """,
            (invite_id,),
        ).fetchone()
        sync_user_ids = _household_sync_user_ids(db, household_id, target["id"])
        result = {"invite": dict(invite)}
    await broadcast_sync_to_users(sync_user_ids)
    return result


@router.post("/{household_id}/invites/{invite_id}")
async def respond_to_household_invite_endpoint(
    household_id: int,
    invite_id: int,
    data: HouseholdInviteResponse,
    user_id: int = Depends(require_auth),
):
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        invite = db.execute(
            "SELECT household_id FROM household_members WHERE id = ? AND user_id = ?",
            (invite_id, user_id),
        ).fetchone()
        if not invite or invite["household_id"] != household_id:
            raise HTTPException(404, "Household invitation not found")
        sync_user_ids = _household_sync_user_ids(db, household_id, user_id)
        try:
            respond_to_household_invite(db, invite_id, user_id, accept=data.accept)
            db.commit()
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        await broadcast_sync_to_users(sync_user_ids)
        return {
            "id": invite_id,
            "household_id": household_id,
            "status": "accepted" if data.accept else "declined",
        }


@router.post("/{household_id}/leave")
async def leave_household_endpoint(
    household_id: int,
    user_id: int = Depends(require_auth),
):
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        sync_user_ids = _household_sync_user_ids(db, household_id, user_id)
        try:
            leave_household(db, household_id, user_id)
            db.commit()
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        await broadcast_sync_to_users(sync_user_ids)
        return {"household_id": household_id, "user_id": user_id, "status": "left"}


@router.delete("/{household_id}/members/{member_user_id}")
async def remove_household_member_endpoint(
    household_id: int,
    member_user_id: int,
    user_id: int = Depends(require_auth),
):
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        sync_user_ids = _household_sync_user_ids(db, household_id, member_user_id)
        try:
            remove_household_member(db, household_id, user_id, member_user_id)
            db.commit()
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc
        await broadcast_sync_to_users(sync_user_ids)
        return {"household_id": household_id, "user_id": member_user_id, "status": "removed"}


@router.post("/{household_id}/transfer-owner")
async def transfer_household_owner_endpoint(
    household_id: int,
    data: HouseholdOwnerTransfer,
    user_id: int = Depends(require_auth),
):
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        sync_user_ids = _household_sync_user_ids(db, household_id, user_id, data.user_id)
        try:
            transfer_household_ownership(db, household_id, user_id, data.user_id)
            db.commit()
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        await broadcast_sync_to_users(sync_user_ids)
        return {"household": _household_view(db, household_id, data.user_id)}


@router.delete("/{household_id}")
async def dissolve_household_endpoint(
    household_id: int,
    user_id: int = Depends(require_auth),
):
    """Dissolve a household and transfer its entities to the human owner."""
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        household = db.execute(
            "SELECT owner_user_id FROM households WHERE id = ?",
            (household_id,),
        ).fetchone()
        if not household:
            raise HTTPException(404, "Household not found")
        if household["owner_user_id"] != user_id:
            raise HTTPException(403, "Only the household owner can dissolve the household")

        entities = db.execute(
            "SELECT entity_type, entity_id FROM entity_access WHERE owner_household_id = ?",
            (household_id,),
        ).fetchall()
        sync_user_ids = _household_sync_user_ids(db, household_id, user_id)
        sync_user_ids.update(
            row["user_id"] for row in db.execute(
                """SELECT DISTINCT eag.user_id
                   FROM entity_access_grants eag
                   JOIN entity_access ea ON ea.id = eag.entity_access_id
                   WHERE ea.owner_household_id = ?""",
                (household_id,),
            ).fetchall()
        )
        project_ids = [row["entity_id"] for row in entities if row["entity_type"] == "project"]
        for project_id in project_ids:
            sync_user_ids.update(get_project_participant_user_ids(db, project_id))

        db.execute(
            """UPDATE entity_access
               SET owner_user_id = ?, owner_household_id = NULL, updated_at = CURRENT_TIMESTAMP
               WHERE owner_household_id = ?""",
            (user_id, household_id),
        )
        db.execute("DELETE FROM households WHERE id = ?", (household_id,))
        db.commit()

        for project_id in project_ids:
            sync_user_ids.update(get_project_participant_user_ids(db, project_id))
    await broadcast_sync_to_users(sync_user_ids)
    return {"deleted": household_id, "transferred_entity_count": len(entities)}
