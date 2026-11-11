"""nia-todo: Project sharing endpoints"""

from typing import Optional
from fastapi import APIRouter, HTTPException, Depends, Request
from pydantic import BaseModel, Field

from db import get_db, now_iso
from routers.auth import require_auth
from routers.websocket import broadcast_sync_to_users
from services.entity_sharing_notifications import notify_entity_share_invite
from services.websocket import broadcast_change
from services.entity_access import (
    get_entity_access_boundary_user_ids,
    invite_entity_access,
    leave_entity_access,
    list_entity_access_invites,
    list_entity_access_members,
    remove_entity_access,
    respond_to_entity_invite,
    restore_entity_access,
)
from services.sharing import can_access_project, can_edit_project, get_project_access_flags, get_project_ids_for_user, get_project_member_rows, get_project_participant_user_ids

router = APIRouter(prefix="/api/projects")

# ─── Pydantic Models ─────────────────────────────────────────────────────────

class ShareProjectRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=254)

class AcceptInviteRequest(BaseModel):
    accept: bool  # True = annehmen, False = ablehnen

class MemberColorOverride(BaseModel):
    color: str = Field(..., pattern=r'^#[0-9a-fA-F]{6}$')


class RestoreMemberRequest(BaseModel):
    status: str = Field(default="accepted", pattern=r'^(accepted|pending)$')


# ─── Helpers ───────────────────────────────────────────────────────────────────


def is_email_identifier(identifier: str) -> bool:
    return "@" in (identifier or "")


def get_user_by_verified_email(db, email: str) -> Optional[dict]:
    """Find user by verified email only. Does not match usernames."""
    row = db.execute(
        """SELECT id, username, display_name, email, email_verified_at, language
           FROM users
           WHERE lower(email) = lower(?) AND email_verified_at IS NOT NULL
           LIMIT 1""",
        (email,)
    ).fetchone()
    return dict(row) if row else None

def get_user_by_identifier(db, identifier: str) -> Optional[dict]:
    row = db.execute(
        """SELECT id, username, display_name, email, email_verified_at, language
           FROM users
           WHERE username = ?
              OR (lower(email) = lower(?) AND email_verified_at IS NOT NULL)
           ORDER BY CASE WHEN username = ? THEN 0 ELSE 1 END
           LIMIT 1""",
        (identifier, identifier, identifier)
    ).fetchone()
    return dict(row) if row else None

def get_project_with_owner(db, project_id: int) -> Optional[dict]:
    row = db.execute(
        """
        SELECT p.*, ea.owner_user_id, ea.owner_household_id,
               COALESCE(ea.owner_user_id, h.owner_user_id) AS owner_id,
               u.username AS owner_username, u.display_name AS owner_display_name
        FROM projects p
        JOIN entity_access ea ON ea.entity_type = 'project' AND ea.entity_id = p.id
        LEFT JOIN households h ON h.id = ea.owner_household_id
        JOIN users u ON u.id = COALESCE(ea.owner_user_id, h.owner_user_id)
        WHERE p.id = ?
        """,
        (project_id,)
    ).fetchone()
    return dict(row) if row else None


def require_personal_project_sharing(db, project: dict, user_id: int) -> None:
    if project.get("owner_household_id") is not None:
        if not can_access_project(db, project["id"], user_id):
            raise HTTPException(403, "Not authorized to manage project sharing")
        raise HTTPException(409, "Household projects cannot be shared directly")


def get_project_member(db, project_id: int, user_id: int) -> Optional[dict]:
    rows = get_project_member_rows(db, project_id, include_pending=True)
    return next((row for row in rows if row["user_id"] == user_id), None)

def get_member_by_id(db, member_id: int) -> Optional[dict]:
    row = db.execute(
        """SELECT ea.entity_id AS project_id, grant_row.user_id
           FROM entity_access_grants grant_row
           JOIN entity_access ea ON ea.id = grant_row.entity_access_id
           WHERE grant_row.id = ? AND ea.entity_type = 'project'""",
        (member_id,),
    ).fetchone()
    return get_project_member(db, row["project_id"], row["user_id"]) if row else None

def get_project_members(db, project_id: int, include_inactive=False, owner_only=False) -> list:
    members = list_entity_access_members(
        db,
        "project",
        project_id,
        include_inactive=include_inactive,
    )
    for member in members:
        preferences = db.execute(
            """SELECT workspace_id, user_color FROM project_members
               WHERE project_id = ? AND user_id = ?""",
            (project_id, member["user_id"]),
        ).fetchone()
        member["workspace_id"] = preferences["workspace_id"] if preferences else None
        member["user_color"] = preferences["user_color"] if preferences else None
    if owner_only:
        members = [member for member in members if member["status"] == "accepted"]
    return members

def get_shared_projects_for_user(db, user_id: int) -> list:
    """Get all projects shared with a user (as member, not owner)."""
    default_workspace_id = get_user_default_workspace_id(db, user_id)
    projects = []
    for project_id in get_project_ids_for_user(db, user_id):
        flags = get_project_access_flags(db, project_id, user_id)
        if flags["can_manage"]:
            continue
        project = get_project_with_owner(db, project_id)
        if not project:
            continue
        member = flags["direct_member"]
        project["user_id"] = project["owner_id"]
        project["owner_workspace_id"] = project["workspace_id"]
        project["workspace_id"] = (
            member["workspace_id"]
            if member is not None and member["workspace_id"] is not None
            else default_workspace_id
        )
        project["is_shared"] = 1
        project["is_owner"] = 0
        project["member_status"] = member["status"] if member is not None else "accepted"
        project["member_color"] = member["user_color"] if member is not None else None
        project["member_id"] = member["id"] if member is not None else None
        if member is not None and member["updated_at"] and member["updated_at"] > project["updated_at"]:
            project["updated_at"] = member["updated_at"]
        projects.append(project)
    return projects

def get_pending_invites_for_user(db, user_id: int) -> list:
    """Get all pending project invites for a user."""
    invites = list_entity_access_invites(db, user_id, "project")
    for invite in invites:
        project = db.execute(
            "SELECT name, color FROM projects WHERE id = ?",
            (invite["entity_id"],),
        ).fetchone()
        invite["project_id"] = invite["entity_id"]
        invite["project_name"] = project["name"] if project else None
        invite["project_color"] = project["color"] if project else None
    return invites


def get_user_default_workspace_id(db, user_id: int):
    row = db.execute(
        "SELECT id FROM workspaces WHERE user_id = ? AND COALESCE(is_default, 0) = 1 ORDER BY id LIMIT 1",
        (user_id,),
    ).fetchone()
    return row['id'] if row else None


# ─── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/shared")
def list_shared_projects(user_id: int = Depends(require_auth)):
    """List all projects shared with the current user."""
    with get_db() as db:
        projects = get_shared_projects_for_user(db, user_id)
        return {"projects": projects}


@router.get("/invites")
def list_pending_invites(user_id: int = Depends(require_auth)):
    """List all pending project invites for the current user."""
    with get_db() as db:
        invites = get_pending_invites_for_user(db, user_id)
        return {"invites": invites}


@router.post("/{project_id}/share")
async def share_project(project_id: int, data: ShareProjectRequest, request: Request, user_id: int = Depends(require_auth)):
    """Share a project with another user. Owner only."""
    with get_db() as db:
        # Check project exists and user is owner
        project = get_project_with_owner(db, project_id)
        if not project:
            raise HTTPException(404, "Project not found")
        if not can_edit_project(db, project_id, user_id):
            raise HTTPException(403, "Only the project owner can share this project")
        require_personal_project_sharing(db, project, user_id)

        identifier = data.username.strip()
        email_identifier = is_email_identifier(identifier)
        # Find target user: for email identifiers, only match verified emails (not usernames)
        if email_identifier:
            target = get_user_by_verified_email(db, identifier)
        else:
            target = get_user_by_identifier(db, identifier)
        if not target:
            raise HTTPException(404, "User not found")

        # Cannot share with self
        if target['id'] == project['owner_id']:
            raise HTTPException(400, "Cannot share a project with yourself")

        try:
            invite = invite_entity_access(
                db,
                "project",
                project_id,
                user_id,
                target["id"],
                invite_identifier_type="email" if email_identifier else "username",
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        db.execute(
            """INSERT INTO project_members
               (project_id, user_id, invited_by, status, invite_identifier_type, created_at, updated_at)
               VALUES (?, ?, ?, 'pending', ?, datetime('now'), datetime('now'))
               ON CONFLICT(project_id, user_id) DO UPDATE SET
                   invited_by = excluded.invited_by,
                   status = 'pending',
                   invite_identifier_type = excluded.invite_identifier_type,
                   updated_at = excluded.updated_at""",
            (project_id, target["id"], user_id, "email" if email_identifier else "username"),
        )
        db.commit()
        notification_delivery = await notify_entity_share_invite(
            db=db,
            request=request,
            target=target,
            actor={
                "id": project["owner_id"],
                "username": project.get("owner_username"),
                "display_name": project.get("owner_display_name"),
            },
            entity_type="project",
            entity_id=project_id,
            entity_name=project.get("name") or "",
        )
        db.commit()

        member = get_project_member(db, project_id, target['id']) or dict(invite)
        await broadcast_sync_to_users({project['owner_id'], target['id']})
        return {"member": member, "notification_delivery": notification_delivery}


@router.post("/{project_id}/members/{member_user_id}/restore")
async def restore_member(project_id: int, member_user_id: int, data: RestoreMemberRequest, user_id: int = Depends(require_auth)):
    """Restore a removed/left member. Owner restores removals; a member can undo their own leave."""
    with get_db() as db:
        relationship = db.execute(
            """SELECT grant_row.id, access.owner_user_id
               FROM entity_access_grants grant_row
               JOIN entity_access access ON access.id = grant_row.entity_access_id
               WHERE access.entity_type = 'project' AND access.entity_id = ? AND grant_row.user_id = ?""",
            (project_id, member_user_id),
        ).fetchone()
        if not relationship or (relationship["owner_user_id"] != user_id and member_user_id != user_id):
            raise HTTPException(404, "Member not found")
        project = get_project_with_owner(db, project_id)
        if not project:
            raise HTTPException(404, "Member not found")
        require_personal_project_sharing(db, project, user_id)

        member = get_project_member(db, project_id, member_user_id)
        if not member:
            raise HTTPException(404, "Member not found")

        is_owner = relationship["owner_user_id"] == user_id
        is_self = member_user_id == user_id
        if not is_owner and not is_self:
            raise HTTPException(403, "Only the owner or the member can restore this membership")
        try:
            restore_entity_access(
                db,
                "project",
                project_id,
                user_id,
                member_user_id,
                status=data.status,
            )
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        workspace_id = get_user_default_workspace_id(db, member_user_id) if data.status == 'accepted' else member['workspace_id']
        db.execute(
            """UPDATE project_members SET status = ?, workspace_id = COALESCE(?, workspace_id),
                      updated_at = datetime('now')
               WHERE project_id = ? AND user_id = ?""",
            (data.status, workspace_id, project_id, member_user_id),
        )
        db.commit()

        restored = get_project_member(db, project_id, member_user_id)

        if data.status == 'pending':
            await broadcast_sync_to_users({project['owner_id'], member_user_id})
        elif data.status == 'accepted':
            await broadcast_sync_to_users(get_project_participant_user_ids(db, project_id))
        return {"member": restored}


def transition_member_status(db, member_id: int, expected_status: str, new_status: str) -> bool:
    """Compare-and-swap one membership status."""
    updated = db.execute(
        """UPDATE entity_access_grants
           SET status = ?, updated_at = datetime('now')
           WHERE id = ? AND status = ?""",
        (new_status, member_id, expected_status),
    )
    return updated.rowcount == 1


def transition_pending_invite(db, invite_id: int, new_status: str, workspace_id) -> bool:
    """Atomically transition an invitation only while it is still pending."""
    updated = db.execute(
        """UPDATE entity_access_grants
           SET status = ?, updated_at = datetime('now')
           WHERE id = ? AND status = 'pending'""",
        (new_status, invite_id),
    )
    return updated.rowcount == 1


@router.post("/{project_id}/invites/{invite_id}")
async def respond_to_invite(project_id: int, invite_id: int, data: AcceptInviteRequest, user_id: int = Depends(require_auth)):
    """Accept or decline a project invitation."""
    with get_db() as db:
        invite = db.execute(
            """SELECT grant_row.*, preferences.workspace_id
               FROM entity_access_grants grant_row
               JOIN entity_access ea ON ea.id = grant_row.entity_access_id
               LEFT JOIN project_members preferences
                 ON preferences.project_id = ea.entity_id AND preferences.user_id = grant_row.user_id
               WHERE grant_row.id = ? AND grant_row.user_id = ?
                 AND ea.entity_type = 'project' AND ea.entity_id = ?""",
            (invite_id, user_id, project_id),
        ).fetchone()
        if not invite:
            raise HTTPException(404, "Invite not found")
        project = get_project_with_owner(db, project_id)
        if not project:
            raise HTTPException(404, "Invite not found")
        require_personal_project_sharing(db, project, user_id)

        new_status = 'accepted' if data.accept else 'declined'
        workspace_id = get_user_default_workspace_id(db, user_id) if data.accept else invite['workspace_id']
        try:
            respond_to_entity_invite(
                db,
                "project",
                project_id,
                invite_id,
                user_id,
                accept=data.accept,
            )
        except ValueError as exc:
            db.rollback()
            raise HTTPException(409, str(exc)) from exc
        db.execute(
            """UPDATE project_members SET status = ?, workspace_id = COALESCE(?, workspace_id),
                      updated_at = datetime('now')
               WHERE project_id = ? AND user_id = ?""",
            (new_status, workspace_id, project_id, user_id),
        )
        db.commit()

        if data.accept:
            await broadcast_sync_to_users(get_project_participant_user_ids(db, project_id))
        else:
            await broadcast_sync_to_users({project['owner_id'], user_id})

        return {"id": invite_id, "status": new_status, "project_id": project_id}


@router.delete("/{project_id}/members/{member_user_id}")
async def remove_member(project_id: int, member_user_id: int, user_id: int = Depends(require_auth)):
    """Remove a member from a project. Owner can remove anyone; members can remove themselves."""
    with get_db() as db:
        project = get_project_with_owner(db, project_id)
        if not project:
            raise HTTPException(404, "Project not found")
        require_personal_project_sharing(db, project, user_id)

        member = get_project_member(db, project_id, member_user_id)
        if not member:
            raise HTTPException(404, "Member not found")
        is_owner = can_edit_project(db, project_id, user_id)
        is_self = member_user_id == user_id
        if not is_owner and not is_self:
            raise HTTPException(403, "Only the owner can remove members")
        sync_user_ids = get_entity_access_boundary_user_ids(db, "project", project_id)

        try:
            if is_self and not is_owner:
                leave_entity_access(db, "project", project_id, user_id)
                new_status = "left"
            else:
                remove_entity_access(db, "project", project_id, user_id, member_user_id)
                new_status = "removed"
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        db.execute(
            """UPDATE project_members SET status = ?, updated_at = datetime('now')
               WHERE project_id = ? AND user_id = ?""",
            (new_status, project_id, member_user_id),
        )
        db.commit()

        await broadcast_sync_to_users(sync_user_ids)

        return {"removed": member['id'], "project_id": project_id}


@router.post("/{project_id}/leave")
async def leave_project(project_id: int, user_id: int = Depends(require_auth)):
    """Leave a shared project (member-only)."""
    with get_db() as db:
        project = get_project_with_owner(db, project_id)
        if not project:
            raise HTTPException(404, "Project not found")
        if not can_access_project(db, project_id, user_id):
            raise HTTPException(403, "Not authorized to leave this project")
        require_personal_project_sharing(db, project, user_id)
        if can_edit_project(db, project_id, user_id):
            raise HTTPException(400, "Owner cannot leave their own project. Delete it instead.")

        member = get_project_member(db, project_id, user_id)
        if not member or member['status'] != 'accepted':
            raise HTTPException(400, "You are not a member of this project")
        sync_user_ids = get_entity_access_boundary_user_ids(db, "project", project_id)

        try:
            leave_entity_access(db, "project", project_id, user_id)
        except PermissionError as exc:
            raise HTTPException(409, str(exc)) from exc
        db.execute(
            """UPDATE project_members SET status = 'left', updated_at = datetime('now')
               WHERE project_id = ? AND user_id = ?""",
            (project_id, user_id),
        )
        db.commit()

        await broadcast_sync_to_users(sync_user_ids)

        return {"left": member['id'], "project_id": project_id}


@router.post("/{project_id}/leave/undo")
async def undo_leave_project(project_id: int, user_id: int = Depends(require_auth)):
    """Undo leaving a shared project for the current user."""
    with get_db() as db:
        project = get_project_with_owner(db, project_id)
        if not project:
            raise HTTPException(404, "Project not found")
        require_personal_project_sharing(db, project, user_id)

        member = get_project_member(db, project_id, user_id)
        if not member or member['status'] != 'left':
            raise HTTPException(400, "No leave action to undo")
        if can_edit_project(db, project_id, user_id):
            raise HTTPException(400, "Owner cannot leave their own project")

        try:
            restore_entity_access(
                db,
                "project",
                project_id,
                user_id,
                user_id,
                status="accepted",
            )
        except (PermissionError, ValueError) as exc:
            raise HTTPException(409, str(exc)) from exc
        db.execute(
            """UPDATE project_members SET status = 'accepted', updated_at = datetime('now')
               WHERE project_id = ? AND user_id = ?""",
            (project_id, user_id),
        )
        db.commit()

        restored = get_project_member(db, project_id, user_id)
        await broadcast_sync_to_users(get_project_participant_user_ids(db, project_id))
        return {"member": restored}


@router.get("/{project_id}/members")
def list_project_members(project_id: int, user_id: int = Depends(require_auth)):
    """List all members of a project (owner and members)."""
    with get_db() as db:
        project = get_project_with_owner(db, project_id)
        if not project:
            raise HTTPException(404, "Project not found")

        # Check access through ownership, household membership, or direct sharing.
        if not can_access_project(db, project_id, user_id):
            raise HTTPException(403, "Not authorized to view members")
        require_personal_project_sharing(db, project, user_id)
        is_owner = can_edit_project(db, project_id, user_id)

        # Owners must see their own pending invites so they can revoke them even
        # after a reload. Non-owners still only see accepted members to avoid
        # leaking pending invite state to other project members.
        members = get_project_members(db, project_id, include_inactive=False, owner_only=not is_owner)
        return {"members": members}


@router.patch("/{project_id}/members/{member_user_id}/color")
async def update_member_color(project_id: int, member_user_id: int, data: MemberColorOverride, user_id: int = Depends(require_auth)):
    """Update a member's color override (owner only)."""
    with get_db() as db:
        project = get_project_with_owner(db, project_id)
        if not project:
            raise HTTPException(404, "Project not found")
        if not can_edit_project(db, project_id, user_id):
            raise HTTPException(403, "Only the owner can change member colors")
        require_personal_project_sharing(db, project, user_id)

        db.execute(
            """UPDATE project_members
               SET user_color = ?, updated_at = datetime('now')
               WHERE project_id = ? AND user_id = ?""",
            (data.color, project_id, member_user_id)
        )
        db.commit()

        await broadcast_change("member_color_changed", {
            "project_id": project_id,
            "user_id": member_user_id,
            "color": data.color
        }, user_id, project_id)

        return {"project_id": project_id, "user_id": member_user_id, "color": data.color}
