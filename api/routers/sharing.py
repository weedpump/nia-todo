"""nia-todo: Project sharing endpoints"""

from typing import Optional
from fastapi import APIRouter, HTTPException, Depends, Request
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from db import get_db, now_iso
from routers.auth import require_auth
from services.audit import log_audit
from services.email import send_email
from services.email_config import can_send_email_links
from services.email_templates import project_share_invite_email
from services.instance_config import get_public_base_url
from services.websocket import broadcast_change

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


def _neutral_email_share_response() -> dict:
    return {"member": None, "notification_delivery": "unknown", "message": "If a matching verified account exists, the invitation has been processed."}

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
        """SELECT p.*, u.username as owner_username, u.display_name as owner_display_name
           FROM projects p
           JOIN users u ON p.user_id = u.id
           WHERE p.id = ?""",
        (project_id,)
    ).fetchone()
    return dict(row) if row else None

def get_project_member(db, project_id: int, user_id: int) -> Optional[dict]:
    row = db.execute(
        """SELECT pm.*, u.username, u.display_name
           FROM project_members pm
           JOIN users u ON pm.user_id = u.id
           WHERE pm.project_id = ? AND pm.user_id = ?""",
        (project_id, user_id)
    ).fetchone()
    return dict(row) if row else None

def get_member_by_id(db, member_id: int) -> Optional[dict]:
    row = db.execute(
        """SELECT pm.*, u.username, u.display_name, p.user_id as owner_id
           FROM project_members pm
           JOIN users u ON pm.user_id = u.id
           JOIN projects p ON p.id = pm.project_id
           WHERE pm.id = ?""",
        (member_id,)
    ).fetchone()
    return dict(row) if row else None

def get_project_members(db, project_id: int, include_inactive=False, owner_only=False) -> list:
    """Get all members for a project.
    
    Args:
        include_inactive: If True, include declined/left/removed members
        owner_only: If True, only return accepted members (for non-owner view)
    """
    if include_inactive:
        rows = db.execute(
            """SELECT pm.*, u.username, u.display_name
               FROM project_members pm
               JOIN users u ON pm.user_id = u.id
               WHERE pm.project_id = ?
               ORDER BY pm.created_at""",
            (project_id,)
        ).fetchall()
    elif owner_only:
        # Non-owners only see accepted members (no pending invites visible)
        rows = db.execute(
            """SELECT pm.*, u.username, u.display_name
               FROM project_members pm
               JOIN users u ON pm.user_id = u.id
               WHERE pm.project_id = ? AND pm.status = 'accepted'
               ORDER BY pm.created_at""",
            (project_id,)
        ).fetchall()
    else:
        # Owner view without inactive: see pending + accepted
        rows = db.execute(
            """SELECT pm.*, u.username, u.display_name
               FROM project_members pm
               JOIN users u ON pm.user_id = u.id
               WHERE pm.project_id = ? AND pm.status IN ('pending', 'accepted')
               ORDER BY pm.created_at""",
            (project_id,)
        ).fetchall()
    return [dict(r) for r in rows]

def get_shared_projects_for_user(db, user_id: int) -> list:
    """Get all projects shared with a user (as member, not owner)."""
    default_workspace_id = get_user_default_workspace_id(db, user_id)
    rows = db.execute(
        """SELECT p.id, p.name, p.color, p.sort_order, p.created_at, max(p.updated_at, COALESCE(pm.updated_at, p.updated_at)) as updated_at, p.parent_id,
                   p.user_id, p.is_inbox, p.workspace_id as owner_workspace_id, p.icon,
                   COALESCE(pm.workspace_id, ?) as workspace_id,
                  1 as is_shared, 0 as is_owner, pm.status as member_status, pm.user_color as member_color,
                  pm.id as member_id, u.username as owner_username
           FROM project_members pm
           JOIN projects p ON pm.project_id = p.id
           JOIN users u ON p.user_id = u.id
           WHERE pm.user_id = ? AND pm.status = 'accepted'""",
        (default_workspace_id, user_id)
    ).fetchall()
    return [dict(r) for r in rows]

def get_pending_invites_for_user(db, user_id: int) -> list:
    """Get all pending invites for a user."""
    rows = db.execute(
        """SELECT pm.*, p.name as project_name, p.color as project_color,
                  u.username as invited_by_username, u.display_name as invited_by_display_name
           FROM project_members pm
           JOIN projects p ON pm.project_id = p.id
           JOIN users u ON pm.invited_by = u.id
           WHERE pm.user_id = ? AND pm.status = 'pending'""",
        (user_id,)
    ).fetchall()
    return [dict(r) for r in rows]


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
        if project['user_id'] != user_id:
            raise HTTPException(403, "Only the project owner can share this project")

        identifier = data.username.strip()
        email_identifier = is_email_identifier(identifier)
        # Find target user: for email identifiers, only match verified emails (not usernames)
        if email_identifier:
            target = get_user_by_verified_email(db, identifier)
        else:
            target = get_user_by_identifier(db, identifier)
        if not target:
            if email_identifier:
                log_audit(db, "project_share_email_identifier_no_match", user_id=user_id, details=f"project_id={project_id}")
                db.commit()
                return _neutral_email_share_response()
            raise HTTPException(404, "User not found")

        # Cannot share with self
        if target['id'] == project['user_id']:
            if email_identifier:
                log_audit(db, "project_share_email_identifier_self", user_id=user_id, details=f"project_id={project_id}")
                db.commit()
                return _neutral_email_share_response()
            raise HTTPException(400, "Cannot share a project with yourself")

        # Check if already shared
        existing = db.execute(
            "SELECT id, status FROM project_members WHERE project_id = ? AND user_id = ?",
            (project_id, target['id'])
        ).fetchone()
        if existing and existing['status'] in ('pending', 'accepted'):
            if email_identifier:
                log_audit(db, "project_share_email_identifier_existing", user_id=target['id'], details=f"project_id={project_id}; invited_by={user_id}")
                db.commit()
                return _neutral_email_share_response()
            raise HTTPException(400, "User already has access or a pending invite")

        # Create invitation
        c = db.execute(
            """INSERT INTO project_members (project_id, user_id, invited_by, status, created_at, updated_at)
               VALUES (?, ?, ?, 'pending', datetime('now'), datetime('now'))
               ON CONFLICT(project_id, user_id) DO UPDATE SET
               status = 'pending', invited_by = excluded.invited_by, updated_at = datetime('now')""",
            (project_id, target['id'], user_id)
        )
        emailed = False
        db.commit()
        if can_send_email_links() and target.get('email') and target.get('email_verified_at'):
            subject, text, html = project_share_invite_email(
                display_name=target.get('display_name') or target.get('username'),
                username=target.get('username'),
                project_name=project.get('name'),
                inviter_name=project.get('owner_display_name') or project.get('owner_username'),
                link=get_public_base_url(request, require_configured=True),
                language=target.get('language') or 'de',
            )
            try:
                await run_in_threadpool(send_email, to=target['email'], subject=subject, text=text, html=html)
                emailed = True
                log_audit(db, "project_share_email_sent", user_id=target['id'], details=f"project_id={project_id}; invited_by={user_id}")
            except Exception:
                log_audit(db, "project_share_email_failed", user_id=target['id'], details=f"project_id={project_id}; invited_by={user_id}; fallback=in_app")
        db.commit()

        # For email identifiers, do NOT broadcast to owner (avoids enumeration via WebSocket)
        # Only notify the invited user directly without project_id (prevents owner/accepted member recipients)
        if email_identifier:
            # Direct broadcast to invitee only (no project_id = no owner/member auto-recipients)
            await broadcast_change("member_invited", {"member": None}, target['id'])
            log_audit(db, "project_share_email_identifier_accepted", user_id=target['id'], details=f"project_id={project_id}; invited_by={user_id}")
            return _neutral_email_share_response()
        
        # For username identifiers, return member details to owner (they initiated the invite)
        # Broadcast only to invitee (no project_id = no owner/member auto-recipients) to avoid leaking pending invites
        member = get_project_member(db, project_id, target['id'])
        await broadcast_change("member_invited", {"member": None}, target['id'])
        return {"member": member, "notification_delivery": "email" if emailed else "in_app"}


@router.post("/{project_id}/members/{member_user_id}/restore")
async def restore_member(project_id: int, member_user_id: int, data: RestoreMemberRequest, user_id: int = Depends(require_auth)):
    """Restore a removed/left member. Owner restores removals; a member can undo their own leave."""
    with get_db() as db:
        project = get_project_with_owner(db, project_id)
        if not project:
            raise HTTPException(404, "Project not found")

        member = db.execute(
            "SELECT * FROM project_members WHERE project_id = ? AND user_id = ?",
            (project_id, member_user_id)
        ).fetchone()
        if not member:
            raise HTTPException(404, "Member not found")

        is_owner = project['user_id'] == user_id
        is_self = member_user_id == user_id
        if not is_owner and not is_self:
            raise HTTPException(403, "Only the owner or the member can restore this membership")
        if is_self and member['status'] != 'left':
            raise HTTPException(403, "Members can only undo their own leave action")
        if is_owner and member['status'] not in ('removed', 'left', 'declined'):
            raise HTTPException(400, "Member cannot be restored from current status")

        workspace_id = get_user_default_workspace_id(db, member_user_id) if data.status == 'accepted' else member['workspace_id']
        db.execute(
            "UPDATE project_members SET status = ?, workspace_id = COALESCE(?, workspace_id), updated_at = datetime('now') WHERE id = ?",
            (data.status, workspace_id, member['id'])
        )
        db.commit()

        restored = get_project_member(db, project_id, member_user_id)
        
        # Do NOT broadcast pending invites to owner/members (privacy: pending invites are internal)
        if data.status == 'pending':
            # Notify only the invitee (no project_id = no owner/member auto-recipients)
            await broadcast_change("member_restored", {"member": None}, member_user_id)
        else:
            # For accepted/other status, notify owner and the restored member (no project_id to avoid leaking to other members)
            await broadcast_change("member_restored", {"project_id": project_id, "member": restored}, project['user_id'])
            if member_user_id != project['user_id']:
                await broadcast_change("member_restored", {"project_id": project_id, "member": restored}, member_user_id)
        return {"member": restored}


@router.post("/{project_id}/invites/{invite_id}")
async def respond_to_invite(project_id: int, invite_id: int, data: AcceptInviteRequest, user_id: int = Depends(require_auth)):
    """Accept or decline a project invitation."""
    with get_db() as db:
        # Get the invite
        invite = db.execute(
            """SELECT pm.*, p.user_id as owner_id
               FROM project_members pm
               JOIN projects p ON pm.project_id = p.id
               WHERE pm.id = ? AND pm.user_id = ? AND pm.project_id = ?""",
            (invite_id, user_id, project_id)
        ).fetchone()
        if not invite:
            raise HTTPException(404, "Invite not found")
        if invite['status'] != 'pending':
            raise HTTPException(400, "Invite is not pending")

        new_status = 'accepted' if data.accept else 'declined'
        workspace_id = get_user_default_workspace_id(db, user_id) if data.accept else invite['workspace_id']
        db.execute(
            "UPDATE project_members SET status = ?, workspace_id = COALESCE(?, workspace_id), updated_at = datetime('now') WHERE id = ?",
            (new_status, workspace_id, invite_id)
        )
        db.commit()

        # Notify both users
        if data.accept:
            await broadcast_change("member_accepted", {"id": invite_id, "project_id": project_id}, user_id)
            await broadcast_change("member_accepted", {"id": invite_id, "project_id": project_id}, invite['owner_id'])
        else:
            await broadcast_change("member_declined", {"id": invite_id, "project_id": project_id}, invite['owner_id'])

        return {"id": invite_id, "status": new_status, "project_id": project_id}


@router.delete("/{project_id}/members/{member_user_id}")
async def remove_member(project_id: int, member_user_id: int, user_id: int = Depends(require_auth)):
    """Remove a member from a project. Owner can remove anyone; members can remove themselves."""
    with get_db() as db:
        project = get_project_with_owner(db, project_id)
        if not project:
            raise HTTPException(404, "Project not found")

        # Owner can remove anyone, member can only remove self
        is_owner = project['user_id'] == user_id
        is_self = member_user_id == user_id
        if not is_owner and not is_self:
            raise HTTPException(403, "Only the owner can remove members")

        member = db.execute(
            "SELECT * FROM project_members WHERE project_id = ? AND user_id = ?",
            (project_id, member_user_id)
        ).fetchone()
        if not member:
            raise HTTPException(404, "Member not found")
        if member['status'] not in ('pending', 'accepted'):
            raise HTTPException(400, "Member is not active")

        # Mark as removed instead of deleting for undo support
        db.execute(
            "UPDATE project_members SET status = 'removed', updated_at = datetime('now') WHERE id = ?",
            (member['id'],)
        )
        db.commit()

        # Do NOT broadcast pending invites to owner/members (privacy: pending invites are internal)
        # Only notify the affected user directly without project_id
        if member['status'] == 'pending':
            # Notify only the invitee (no project_id = no owner/member auto-recipients)
            await broadcast_change("member_removed", {"member": None}, member_user_id)
        else:
            # For accepted members, notify owner and the removed member (no project_id to avoid leaking to other members)
            await broadcast_change("member_removed", {
                "id": member['id'],
                "project_id": project_id,
                "user_id": member_user_id,
                "member": dict(member)
            }, user_id)

            # Also notify the removed user
            if member_user_id != user_id:
                await broadcast_change("member_removed", {
                    "id": member['id'],
                    "project_id": project_id,
                    "user_id": member_user_id
                }, member_user_id)

        return {"removed": member['id'], "project_id": project_id}


@router.post("/{project_id}/leave")
async def leave_project(project_id: int, user_id: int = Depends(require_auth)):
    """Leave a shared project (member-only)."""
    with get_db() as db:
        project = get_project_with_owner(db, project_id)
        if not project:
            raise HTTPException(404, "Project not found")
        if project['user_id'] == user_id:
            raise HTTPException(400, "Owner cannot leave their own project. Delete it instead.")

        member = db.execute(
            "SELECT * FROM project_members WHERE project_id = ? AND user_id = ?",
            (project_id, user_id)
        ).fetchone()
        if not member or member['status'] != 'accepted':
            raise HTTPException(400, "You are not a member of this project")

        # Mark as left instead of deleting for undo support
        db.execute(
            "UPDATE project_members SET status = 'left', updated_at = datetime('now') WHERE id = ?",
            (member['id'],)
        )
        db.commit()

        # Notify owner
        await broadcast_change("member_left", {
            "id": member['id'],
            "project_id": project_id,
            "user_id": user_id,
            "member": dict(member)
        }, project['user_id'], project_id)

        return {"left": member['id'], "project_id": project_id}


@router.post("/{project_id}/leave/undo")
async def undo_leave_project(project_id: int, user_id: int = Depends(require_auth)):
    """Undo leaving a shared project for the current user."""
    with get_db() as db:
        project = get_project_with_owner(db, project_id)
        if not project:
            raise HTTPException(404, "Project not found")
        if project['user_id'] == user_id:
            raise HTTPException(400, "Owner cannot leave their own project")

        member = db.execute(
            "SELECT * FROM project_members WHERE project_id = ? AND user_id = ?",
            (project_id, user_id)
        ).fetchone()
        if not member or member['status'] != 'left':
            raise HTTPException(400, "No leave action to undo")

        db.execute(
            "UPDATE project_members SET status = 'accepted', updated_at = datetime('now') WHERE id = ?",
            (member['id'],)
        )
        db.commit()

        restored = get_project_member(db, project_id, user_id)
        await broadcast_change("member_restored", {"project_id": project_id, "member": restored}, project['user_id'], project_id)
        await broadcast_change("member_restored", {"project_id": project_id, "member": restored}, user_id, project_id)
        return {"member": restored}


@router.get("/{project_id}/members")
def list_project_members(project_id: int, user_id: int = Depends(require_auth)):
    """List all members of a project (owner and members)."""
    with get_db() as db:
        project = get_project_with_owner(db, project_id)
        if not project:
            raise HTTPException(404, "Project not found")

        # Check access: owner or member
        is_owner = project['user_id'] == user_id
        is_member = db.execute(
            "SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ? AND status = 'accepted'",
            (project_id, user_id)
        ).fetchone() is not None

        if not is_owner and not is_member:
            raise HTTPException(403, "Not authorized to view members")

        # All users (including owner) see only accepted members to avoid enumeration via pending invites
        # Pending invites are internal state until accepted
        members = get_project_members(db, project_id, include_inactive=False, owner_only=True)
        return {"members": members}


@router.patch("/{project_id}/members/{member_user_id}/color")
async def update_member_color(project_id: int, member_user_id: int, data: MemberColorOverride, user_id: int = Depends(require_auth)):
    """Update a member's color override (owner only)."""
    with get_db() as db:
        project = get_project_with_owner(db, project_id)
        if not project:
            raise HTTPException(404, "Project not found")
        if project['user_id'] != user_id:
            raise HTTPException(403, "Only the owner can change member colors")

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
