"""Generic direct entity-sharing lifecycle endpoints."""

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from db import get_db
from routers.auth import require_auth
from routers.websocket import broadcast_sync_to_users
from services.entity_access import (
    ENTITY_TYPE_REGISTRY,
    get_entity_access_boundary_user_ids,
    get_entity_ownership,
    invite_entity_access,
    leave_entity_access,
    list_entity_access_members,
    remove_entity_access,
    resolve_entity_access,
    respond_to_entity_invite,
    restore_entity_access,
)
from services.entity_sharing_notifications import notify_entity_share_invite
from services.entity_registry import get_entity_metadata
from services.entity_sharing_payloads import get_entity_invites

router = APIRouter(prefix="/api/entity-sharing")

class InviteCreate(BaseModel):
    identifier: str = Field(min_length=1, max_length=320)


class InviteResponse(BaseModel):
    accept: bool


class RestoreAccessRequest(BaseModel):
    status: str = Field(default="accepted", pattern=r"^(accepted|pending)$")


def _entity_metadata(db, entity_type: str, entity_id: int):
    if entity_type not in ENTITY_TYPE_REGISTRY:
        raise HTTPException(404, "Entity not found")
    return get_entity_metadata(db, entity_type, entity_id)


def _invite_target(db, identifier: str):
    normalized = identifier.strip()
    if not normalized:
        raise HTTPException(400, "User identifier is required")
    if "@" in normalized:
        return db.execute(
            """SELECT id, username, display_name, email, email_verified_at, language
               FROM users
               WHERE lower(email) = lower(?) AND email_verified_at IS NOT NULL""",
            (normalized,),
        ).fetchone()
    return db.execute(
        """SELECT id, username, display_name, email, email_verified_at, language
           FROM users WHERE lower(username) = lower(?)""",
        (normalized,),
    ).fetchone()


def _require_direct_entity(db, entity_type: str, entity_id: int, user_id: int, *, manage: bool = False):
    metadata = _entity_metadata(db, entity_type, entity_id)
    ownership = get_entity_ownership(db, entity_type, entity_id) if metadata else None
    permissions = resolve_entity_access(db, entity_type, entity_id, user_id)
    if not metadata or not ownership or not permissions.can_view:
        raise HTTPException(404, "Entity not found")
    if ownership["owner_household_id"] is not None:
        raise HTTPException(409, "Household entities cannot be shared directly")
    if manage and not permissions.can_manage_access:
        raise HTTPException(403, "Entity access cannot be managed")
    return metadata, permissions


def _sync_project_member_status(db, entity_type: str, entity_id: int, user_id: int, status: str) -> None:
    """Keep the legacy Project preference row aligned without making it authoritative."""
    if entity_type != "project":
        return
    access = get_entity_ownership(db, entity_type, entity_id)
    invited_by = access["owner_user_id"] if access else None
    db.execute(
        """INSERT INTO project_members
           (project_id, user_id, invited_by, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
           ON CONFLICT(project_id, user_id) DO UPDATE SET
               invited_by = COALESCE(excluded.invited_by, project_members.invited_by),
               status = excluded.status,
               updated_at = excluded.updated_at""",
        (entity_id, user_id, invited_by, status),
    )


@router.get("/invites")
def list_pending_entity_invites(user_id: int = Depends(require_auth)):
    with get_db() as db:
        return {"invites": get_entity_invites(db, user_id)}


@router.get("/{entity_type}/{entity_id}/members")
def list_entity_members(entity_type: str, entity_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        _require_direct_entity(db, entity_type, entity_id, user_id, manage=True)
        members = list_entity_access_members(db, entity_type, entity_id)
        return {
            "members": [
                {
                    "id": member["user_id"],
                    "user_id": member["user_id"],
                    "username": member.get("username"),
                    "display_name": member.get("display_name"),
                    "status": member.get("status"),
                }
                for member in members
            ]
        }


@router.post("/{entity_type}/{entity_id}/invites")
async def invite_entity_member(
    entity_type: str,
    entity_id: int,
    data: InviteCreate,
    request: Request,
    user_id: int = Depends(require_auth),
):
    identifier = data.identifier.strip()
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        metadata, _ = _require_direct_entity(db, entity_type, entity_id, user_id, manage=True)
        target_row = _invite_target(db, identifier)
        if not target_row:
            raise HTTPException(404, "User not found")
        target = dict(target_row)
        try:
            invite = invite_entity_access(
                db,
                entity_type,
                entity_id,
                user_id,
                int(target["id"]),
                invite_identifier_type="email" if "@" in identifier else "username",
            )
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        _sync_project_member_status(db, entity_type, entity_id, int(target["id"]), "pending")
        db.commit()
        boundary = get_entity_access_boundary_user_ids(db, entity_type, entity_id)
        result = dict(invite)
        result.update({key: target.get(key) for key in ("username", "display_name")})
        actor_row = db.execute(
            "SELECT id, username, display_name FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        notification_delivery = await notify_entity_share_invite(
            db=db,
            request=request,
            target=target,
            actor=dict(actor_row) if actor_row else {"id": user_id},
            entity_type=entity_type,
            entity_id=entity_id,
            entity_name=metadata["entity_name"],
        )
        db.commit()
    await broadcast_sync_to_users(boundary)
    result["notification_delivery"] = notification_delivery
    return result


@router.post("/{entity_type}/{entity_id}/invites/{invite_id}")
async def respond_to_invite(
    entity_type: str,
    entity_id: int,
    invite_id: int,
    data: InviteResponse,
    user_id: int = Depends(require_auth),
):
    with get_db() as db:
        pending = db.execute(
            """SELECT 1
               FROM entity_access_grants grant_row
               JOIN entity_access access ON access.id = grant_row.entity_access_id
               WHERE grant_row.id = ? AND grant_row.user_id = ? AND grant_row.status = 'pending'
                 AND access.entity_type = ? AND access.entity_id = ?""",
            (invite_id, user_id, entity_type, entity_id),
        ).fetchone()
        if not pending:
            raise HTTPException(404, "Invite not found")
        metadata = _entity_metadata(db, entity_type, entity_id)
        ownership = get_entity_ownership(db, entity_type, entity_id) if metadata else None
        if not metadata or not ownership:
            raise HTTPException(404, "Invite not found")
        if ownership["owner_household_id"] is not None:
            raise HTTPException(404, "Invite not found")
        boundary = get_entity_access_boundary_user_ids(db, entity_type, entity_id)
        try:
            invite = respond_to_entity_invite(
                db,
                entity_type,
                entity_id,
                invite_id,
                user_id,
                accept=data.accept,
            )
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        _sync_project_member_status(db, entity_type, entity_id, user_id, invite["status"])
        db.commit()
        boundary.update(get_entity_access_boundary_user_ids(db, entity_type, entity_id))
    await broadcast_sync_to_users(boundary | {user_id})
    return invite


@router.delete("/{entity_type}/{entity_id}/members/{member_user_id}")
async def remove_entity_member(
    entity_type: str,
    entity_id: int,
    member_user_id: int,
    user_id: int = Depends(require_auth),
):
    with get_db() as db:
        _require_direct_entity(db, entity_type, entity_id, user_id, manage=True)
        boundary = get_entity_access_boundary_user_ids(db, entity_type, entity_id) | {member_user_id}
        try:
            member = remove_entity_access(db, entity_type, entity_id, user_id, member_user_id)
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        _sync_project_member_status(db, entity_type, entity_id, member_user_id, "removed")
        db.commit()
    await broadcast_sync_to_users(boundary)
    return member


@router.post("/{entity_type}/{entity_id}/leave")
async def leave_entity(entity_type: str, entity_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        _, permissions = _require_direct_entity(db, entity_type, entity_id, user_id)
        if permissions.can_manage_access:
            raise HTTPException(400, "Entity manager cannot leave their own entity")
        boundary = get_entity_access_boundary_user_ids(db, entity_type, entity_id)
        try:
            leave_entity_access(db, entity_type, entity_id, user_id)
        except PermissionError as exc:
            raise HTTPException(409, str(exc)) from exc
        _sync_project_member_status(db, entity_type, entity_id, user_id, "left")
        db.commit()
    await broadcast_sync_to_users(boundary)
    return {"entity_type": entity_type, "entity_id": entity_id, "left": True}


@router.post("/{entity_type}/{entity_id}/members/{member_user_id}/restore")
async def restore_entity_member(
    entity_type: str,
    entity_id: int,
    member_user_id: int,
    data: RestoreAccessRequest,
    user_id: int = Depends(require_auth),
):
    with get_db() as db:
        relationship = db.execute(
            """SELECT grant_row.status, access.owner_user_id, access.owner_household_id
               FROM entity_access_grants grant_row
               JOIN entity_access access ON access.id = grant_row.entity_access_id
               WHERE access.entity_type = ? AND access.entity_id = ? AND grant_row.user_id = ?""",
            (entity_type, entity_id, member_user_id),
        ).fetchone()
        is_self = member_user_id == user_id
        if (
            not relationship
            or relationship["owner_household_id"] is not None
            or (relationship["owner_user_id"] != user_id and not is_self)
        ):
            raise HTTPException(404, "Entity member not found")
        metadata = _entity_metadata(db, entity_type, entity_id)
        if not metadata:
            raise HTTPException(404, "Entity member not found")
        try:
            member = restore_entity_access(
                db,
                entity_type,
                entity_id,
                user_id,
                member_user_id,
                status=data.status,
            )
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        _sync_project_member_status(db, entity_type, entity_id, member_user_id, data.status)
        db.commit()
        boundary = get_entity_access_boundary_user_ids(db, entity_type, entity_id) | {member_user_id}
    await broadcast_sync_to_users(boundary)
    return member
