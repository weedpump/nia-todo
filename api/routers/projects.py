"""nia-todo: Project endpoints"""

from typing import Optional
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
import sqlite3

from db import get_db, now_iso
from routers.auth import require_auth
from routers.websocket import broadcast_sync_to_users
from routers.workspaces import ensure_default_workspace, ensure_workspace_inbox
from services.websocket import broadcast_change, broadcast_project_updates
from services.utils import sanitize_text
from services.appearance import normalize_color, normalize_icon
from services.attachments import AttachmentCleanupBatch, commit_with_attachment_recovery
from services.sharing import (
    can_access_project,
    can_edit_project,
    get_project_access_flags,
    get_project_boundary_user_ids,
    get_project_ids_for_user,
    get_project_participant_user_ids,
)
from services.entity_access import (
    get_entity_ownership,
    is_household_participant,
    register_household_entity,
    register_personal_entity,
    same_entity_owner,
    transfer_entity_to_household,
)

router = APIRouter(prefix="/api/projects")


def _project_subtree_ids(db, root_project_id: int) -> list[int]:
    project_ids = [root_project_id]
    queue = [root_project_id]
    while queue:
        parent_id = queue.pop(0)
        child_ids = [row["id"] for row in db.execute(
            "SELECT id FROM projects WHERE parent_id = ?", (parent_id,)
        ).fetchall()]
        project_ids.extend(child_ids)
        queue.extend(child_ids)
    return project_ids


class ProjectCreate(BaseModel):
    name: str
    color: str = "#6366f1"
    icon: Optional[str] = None
    sort_order: int = 0
    parent_id: Optional[int] = None
    workspace_id: Optional[int] = None
    household_id: Optional[int] = None


class ProjectHouseholdTransfer(BaseModel):
    household_id: int
    parent_id: Optional[int] = None


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    icon: Optional[str] = None
    sort_order: Optional[int] = None
    parent_id: Optional[int] = None
    workspace_id: Optional[int] = None


def get_user_default_workspace_id(db, user_id: int) -> Optional[int]:
    row = db.execute(
        "SELECT id FROM workspaces WHERE user_id = ? AND COALESCE(is_default, 0) = 1 ORDER BY id LIMIT 1",
        (user_id,),
    ).fetchone()
    if row:
        return row['id']
    c = db.execute(
        "INSERT INTO workspaces (name, color, icon, sort_order, user_id, is_default, updated_at) VALUES (?, ?, ?, 0, ?, 1, ?)",
        ("Personal", "#10b981", "home", user_id, now_iso()),
    )
    return c.lastrowid


def get_user_inbox_project_id(db, owner_user_id: int, workspace_id: Optional[int] = None) -> Optional[int]:
    if workspace_id is not None:
        row = db.execute(
            """SELECT p.id FROM projects p
               JOIN entity_access ea ON ea.entity_type = 'project' AND ea.entity_id = p.id
               WHERE ea.owner_user_id = ? AND p.workspace_id = ? AND COALESCE(p.is_inbox, 0) = 1
               ORDER BY p.id LIMIT 1""",
            (owner_user_id, workspace_id),
        ).fetchone()
        if row:
            return row['id']
    row = db.execute(
        """SELECT p.id FROM projects p
           JOIN entity_access ea ON ea.entity_type = 'project' AND ea.entity_id = p.id
           WHERE ea.owner_user_id = ? AND COALESCE(p.is_inbox, 0) = 1
           ORDER BY p.id LIMIT 1""",
        (owner_user_id,)
    ).fetchone()
    return row['id'] if row else None


def _project_view_for_user(db, project, user_id: int) -> Optional[dict]:
    flags = get_project_access_flags(db, project["id"], user_id)
    if not flags["can_view"]:
        return None
    ownership = flags["ownership"] or {}
    direct_member = flags["direct_member"]
    default_workspace_id = get_user_default_workspace_id(db, user_id)
    if flags["can_manage"] and ownership.get("owner_user_id") == user_id:
        workspace_id = project["workspace_id"]
    elif direct_member and direct_member["workspace_id"] is not None:
        workspace_id = direct_member["workspace_id"]
    else:
        workspace_id = default_workspace_id
    result = dict(project)
    result["owner_user_id"] = ownership.get("owner_user_id")
    result["owner_household_id"] = ownership.get("owner_household_id")
    result["ownership_type"] = "household" if ownership.get("owner_household_id") is not None else "user"
    result["workspace_id"] = workspace_id
    result["owner_workspace_id"] = project["workspace_id"]
    result["is_owner"] = 1 if flags["can_manage"] else 0
    result["is_shared"] = 0 if flags["can_manage"] else 1
    if ownership.get("owner_user_id") is not None:
        owner = db.execute(
            "SELECT username, display_name FROM users WHERE id = ?",
            (ownership["owner_user_id"],),
        ).fetchone()
        result["owner_username"] = owner["username"] if owner else None
        result["owner_display_name"] = owner["display_name"] if owner else None
        result["household_name"] = None
    else:
        household = db.execute(
            "SELECT name FROM households WHERE id = ?",
            (ownership.get("owner_household_id"),),
        ).fetchone()
        result["owner_username"] = None
        result["owner_display_name"] = None
        result["household_name"] = household["name"] if household else None
    if direct_member:
        result["member_id"] = direct_member["id"]
        result["member_status"] = direct_member["status"]
    return result


@router.get("")
def list_projects(user_id: int = Depends(require_auth)):
    with get_db() as db:
        project_ids = get_project_ids_for_user(db, user_id)
        if not project_ids:
            return {"projects": []}
        placeholders = ",".join("?" for _ in project_ids)
        rows = db.execute(
            f"""
            SELECT * FROM projects
            WHERE id IN ({placeholders})
            ORDER BY COALESCE(is_inbox, 0) DESC, parent_id, sort_order, id
            """,
            tuple(project_ids),
        ).fetchall()
        projects = [_project_view_for_user(db, row, user_id) for row in rows]
        return {"projects": [project for project in projects if project is not None]}


@router.post("")
async def create_project(data: ProjectCreate, user_id: int = Depends(require_auth)):
    data.name = sanitize_text(data.name)
    data.color = normalize_color(data.color)
    data.icon = normalize_icon(data.icon)
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        workspace_id = (
            get_user_default_workspace_id(db, user_id)
            if data.household_id is not None
            else (data.workspace_id or get_user_default_workspace_id(db, user_id))
        )
        workspace = db.execute("SELECT id FROM workspaces WHERE id = ? AND user_id = ?", (workspace_id, user_id)).fetchone()
        if not workspace:
            raise HTTPException(404, "Workspace not found")
        if data.household_id is not None and not is_household_participant(db, data.household_id, user_id):
            raise HTTPException(403, "Not a member of this household")
        if data.parent_id is not None:
            parent = db.execute("SELECT * FROM projects WHERE id = ?", (data.parent_id,)).fetchone()
            if not parent or not can_access_project(db, data.parent_id, user_id):
                raise HTTPException(404, "Parent project not found")
            parent_ownership = get_entity_ownership(db, "project", data.parent_id)
            if data.household_id is None:
                if not parent_ownership or parent_ownership["owner_user_id"] != user_id:
                    raise HTTPException(400, "Parent project has different ownership")
            elif not parent_ownership or parent_ownership["owner_household_id"] != data.household_id:
                raise HTTPException(400, "Parent project belongs to another owner")
        try:
            cursor = db.execute(
                "INSERT INTO projects (name, color, icon, sort_order, parent_id, workspace_id, updated_at, user_id) VALUES (?,?,?,?,?,?,?,?)",
                (data.name, data.color, data.icon, data.sort_order, data.parent_id, workspace_id, now_iso(), user_id),
            )
            if cursor.lastrowid is None:
                raise RuntimeError("Project insert did not return an id")
            project_id = int(cursor.lastrowid)
            if data.household_id is None:
                register_personal_entity(db, "project", project_id, user_id)
            else:
                register_household_entity(db, "project", project_id, user_id, data.household_id)
            db.commit()
        except (sqlite3.IntegrityError, ValueError):
            raise HTTPException(409, "Project could not be saved")
        row = db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        project = _project_view_for_user(db, row, user_id)
        await broadcast_project_updates([project_id], user_id)
        return project


@router.post("/{project_id}/household")
async def transfer_project_to_household_endpoint(
    project_id: int,
    data: ProjectHouseholdTransfer,
    user_id: int = Depends(require_auth),
):
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        project = db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        if not project:
            raise HTTPException(404, "Project not found")
        if project["is_inbox"]:
            raise HTTPException(400, "Inbox cannot be transferred to a household")
        to_transfer = []
        queue = [project_id]
        while queue:
            current_id = queue.pop(0)
            to_transfer.append(current_id)
            children = db.execute("SELECT id FROM projects WHERE parent_id = ?", (current_id,)).fetchall()
            queue.extend(child["id"] for child in children)
        if data.parent_id is not None:
            if data.parent_id in to_transfer:
                raise HTTPException(400, "Household parent cannot be inside the transferred project tree")
            parent = db.execute("SELECT id FROM projects WHERE id = ?", (data.parent_id,)).fetchone()
            parent_ownership = get_entity_ownership(db, "project", data.parent_id) if parent else None
            if not parent or not can_access_project(db, data.parent_id, user_id):
                raise HTTPException(404, "Parent project not found")
            if not parent_ownership or parent_ownership["owner_household_id"] != data.household_id:
                raise HTTPException(400, "Parent project belongs to another owner")
        previous_participant_ids = set()
        for target_id in to_transfer:
            previous_participant_ids.update(get_project_boundary_user_ids(db, target_id))
        for target_id in to_transfer:
            ownership = get_entity_ownership(db, "project", target_id)
            if not ownership or ownership["owner_user_id"] != user_id:
                raise HTTPException(403, "Only a fully personal project tree can be transferred")
        try:
            default_workspace_id = get_user_default_workspace_id(db, user_id)
            db.execute(
                "UPDATE projects SET parent_id = ?, updated_at = ? WHERE id = ?",
                (data.parent_id, now_iso(), project_id),
            )
            for target_id in to_transfer:
                db.execute("DELETE FROM project_members WHERE project_id = ?", (target_id,))
                db.execute(
                    "UPDATE projects SET workspace_id = ?, updated_at = ? WHERE id = ?",
                    (default_workspace_id, now_iso(), target_id),
                )
                transfer_entity_to_household(db, "project", target_id, user_id, data.household_id)
            db.commit()
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        transferred_projects = []
        for target_id in to_transfer:
            row = db.execute("SELECT * FROM projects WHERE id = ?", (target_id,)).fetchone()
            view = _project_view_for_user(db, row, user_id)
            if view is not None:
                transferred_projects.append(view)
        result = dict(next(project for project in transferred_projects if project["id"] == project_id))
        result["transferred_projects"] = transferred_projects
        await broadcast_project_updates(to_transfer, user_id)
        current_participant_ids = set()
        for target_id in to_transfer:
            current_participant_ids.update(get_project_participant_user_ids(db, target_id))
        await broadcast_sync_to_users(previous_participant_ids | current_participant_ids)
        return result


@router.patch("/{project_id}")
async def update_project(project_id: int, data: ProjectUpdate, user_id: int = Depends(require_auth)):
    fields_set = getattr(data, "model_fields_set", getattr(data, "__fields_set__", set()))
    if data.name is not None:
        data.name = sanitize_text(data.name)
    if "color" in fields_set:
        data.color = normalize_color(data.color)
    if "icon" in fields_set:
        data.icon = normalize_icon(data.icon)
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        if not existing:
            raise HTTPException(404, "Project not found")
        is_owner = can_edit_project(db, project_id, user_id)
        member = None
        if not is_owner:
            member = get_project_access_flags(db, project_id, user_id)["direct_member"]
            if not member:
                raise HTTPException(403, "Only the owner can edit this project")
            if fields_set != {"workspace_id"}:
                raise HTTPException(403, "Shared project members can only change their display workspace")
            workspace = db.execute("SELECT id FROM workspaces WHERE id = ? AND user_id = ?", (data.workspace_id, user_id)).fetchone()
            if not workspace:
                raise HTTPException(404, "Workspace not found")
            db.execute(
                "UPDATE project_members SET workspace_id = ?, updated_at = ? WHERE id = ?",
                (data.workspace_id, now_iso(), member['id']),
            )
            db.commit()
            row = db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
            proj = _project_view_for_user(db, row, user_id)
            if not proj:
                raise HTTPException(404, "Project not found")
            await broadcast_change("project_update", proj, user_id)
            return proj
        target_workspace_id = existing['workspace_id']
        moving_workspace = "workspace_id" in fields_set and data.workspace_id != existing['workspace_id']
        if "workspace_id" in fields_set:
            workspace = db.execute("SELECT id FROM workspaces WHERE id = ? AND user_id = ?", (data.workspace_id, user_id)).fetchone()
            if not workspace:
                raise HTTPException(404, "Workspace not found")
            target_workspace_id = data.workspace_id
            if moving_workspace and existing['is_inbox']:
                raise HTTPException(400, "Inbox workspace cannot be changed")

        next_parent_id = data.parent_id if "parent_id" in fields_set else existing['parent_id']
        moving_parent = "parent_id" in fields_set and next_parent_id != existing['parent_id']
        if next_parent_id is not None:
            if next_parent_id == project_id:
                raise HTTPException(400, "Project cannot be its own parent")
            parent = db.execute("SELECT id, parent_id, workspace_id FROM projects WHERE id = ?", (next_parent_id,)).fetchone()
            if not parent or not can_edit_project(db, next_parent_id, user_id):
                raise HTTPException(404, "Parent project not found")
            if not same_entity_owner(db, "project", project_id, next_parent_id):
                raise HTTPException(400, "Parent project belongs to another owner")
            current_check = next_parent_id
            while current_check is not None:
                ancestor = db.execute("SELECT parent_id FROM projects WHERE id = ?", (current_check,)).fetchone()
                if ancestor and ancestor['parent_id'] == project_id:
                    raise HTTPException(400, "Circular dependency")
                current_check = ancestor['parent_id'] if ancestor else None

        access_changed_project_ids = _project_subtree_ids(db, project_id) if moving_parent else []
        previous_access_users = {
            changed_id: get_project_participant_user_ids(db, changed_id)
            for changed_id in access_changed_project_ids
        }

        updates = {}
        for f in ["name", "color", "icon", "sort_order", "parent_id", "workspace_id"]:
            if f in fields_set:
                updates[f] = getattr(data, f)
        if updates:
            updated_at = now_iso()
            updates['updated_at'] = updated_at
            allowed_cols = {"name", "color", "icon", "sort_order", "parent_id", "workspace_id", "updated_at"}
            safe_updates = {k: v for k, v in updates.items() if k in allowed_cols}
            set_clause = ", ".join(f"{k}=:{k}" for k in safe_updates)
            try:
                db.execute(f"UPDATE projects SET {set_clause} WHERE id = :id", {**safe_updates, "id": project_id})
                changed_project_ids = [project_id]
                if moving_workspace:
                    descendant_ids = []
                    queue = [project_id]
                    while queue:
                        current_id = queue.pop(0)
                        children = db.execute("SELECT id FROM projects WHERE parent_id = ?", (current_id,)).fetchall()
                        for child in children:
                            if not same_entity_owner(db, "project", project_id, child['id']):
                                continue
                            descendant_ids.append(child['id'])
                            queue.append(child['id'])
                    if descendant_ids:
                        placeholders = ','.join('?' for _ in descendant_ids)
                        db.execute(
                            f"UPDATE projects SET workspace_id = ?, updated_at = ? WHERE id IN ({placeholders})",
                            (target_workspace_id, updated_at, *descendant_ids),
                        )
                        changed_project_ids.extend(descendant_ids)
                db.commit()
            except sqlite3.IntegrityError:
                raise HTTPException(409, "Project could not be saved")
        else:
            changed_project_ids = [project_id]
        if moving_parent:
            changed_project_ids = list(dict.fromkeys([*changed_project_ids, *access_changed_project_ids]))
        access_boundary_user_ids = set()
        for changed_id, previous_user_ids in previous_access_users.items():
            current_user_ids = get_project_participant_user_ids(db, changed_id)
            access_boundary_user_ids.update(previous_user_ids ^ current_user_ids)
        updated_projects = []
        for changed_id in changed_project_ids:
            updated_row = db.execute("SELECT * FROM projects WHERE id = ?", (changed_id,)).fetchone()
            if updated_row:
                updated_view = _project_view_for_user(db, updated_row, user_id)
                if updated_view:
                    updated_projects.append(updated_view)
        project = updated_projects[0] if updated_projects else _project_view_for_user(db, existing, user_id)
        if project is None:
            raise HTTPException(403, "Not authorized")
        if len(updated_projects) > 1:
            project["updated_projects"] = updated_projects
        await broadcast_project_updates(changed_project_ids, user_id)
        if access_boundary_user_ids:
            await broadcast_sync_to_users(access_boundary_user_ids)
        return project


@router.delete("/{project_id}")
async def delete_project(project_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        proj = db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        if not proj:
            raise HTTPException(404, "Project not found")
        if proj['is_inbox']:
            raise HTTPException(400, "Inbox cannot be deleted")
        if not can_edit_project(db, project_id, user_id):
            raise HTTPException(403, "Only the owner can delete this project")
        to_delete = []
        queue = [project_id]
        while queue:
            pid = queue.pop(0)
            to_delete.append(pid)
            children = db.execute("SELECT id FROM projects WHERE parent_id = ?", (pid,)).fetchall()
            for child in children:
                if same_entity_owner(db, "project", project_id, child['id']):
                    queue.append(child['id'])
        placeholders = ','.join('?' for _ in to_delete)
        event_recipient_ids = set()
        sync_recipient_ids = set()
        for pid in to_delete:
            event_recipient_ids.update(get_project_participant_user_ids(db, pid))
            sync_recipient_ids.update(get_project_boundary_user_ids(db, pid))

        ownership = get_entity_ownership(db, "project", project_id) or {}
        content_owner_user_id = ownership.get("owner_user_id")
        if content_owner_user_id is None and ownership.get("owner_household_id") is not None:
            household = db.execute(
                "SELECT owner_user_id FROM households WHERE id = ?",
                (ownership["owner_household_id"],),
            ).fetchone()
            content_owner_user_id = household["owner_user_id"] if household else None
        destination_inbox_id = (
            get_user_inbox_project_id(db, content_owner_user_id, proj['workspace_id'])
            if content_owner_user_id is not None
            else None
        )
        if destination_inbox_id is None and content_owner_user_id is not None:
            owner_workspace_id = ensure_default_workspace(db, content_owner_user_id, commit=False)
            destination_inbox_id = ensure_workspace_inbox(db, content_owner_user_id, owner_workspace_id)
        for pid in to_delete:
            db.execute(
                "UPDATE todos SET project_id = ?, section_id = NULL WHERE project_id = ?",
                (destination_inbox_id, pid),
            )
        for pid in to_delete:
            db.execute("DELETE FROM sections WHERE project_id = ?", (pid,))
        for pid in reversed(to_delete):
            db.execute("DELETE FROM entity_access WHERE entity_type = 'project' AND entity_id = ?", (pid,))
            db.execute("DELETE FROM projects WHERE id = ?", (pid,))
        db.commit()
        destination_recipient_ids = (
            get_project_participant_user_ids(db, destination_inbox_id)
            if destination_inbox_id is not None
            else set()
        )
        await broadcast_change("project_delete", {"id": project_id, "deleted_ids": to_delete}, user_id, recipient_ids=event_recipient_ids)
        await broadcast_sync_to_users(sync_recipient_ids | destination_recipient_ids)
        return {"deleted": project_id, "deleted_ids": to_delete}


@router.post("/{project_id}/clear-done")
async def clear_done_todos(project_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        proj = db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        if not proj:
            raise HTTPException(404, "Project not found")
        if not can_edit_project(db, project_id, user_id):
            raise HTTPException(403, "Not authorized")
        project_ids = [project_id]
        queue = [project_id]
        while queue:
            pid = queue.pop(0)
            children = db.execute("SELECT id FROM projects WHERE parent_id = ?", (pid,)).fetchall()
            for child in children:
                if same_entity_owner(db, "project", project_id, child['id']):
                    project_ids.append(child['id'])
                    queue.append(child['id'])
        placeholders = ','.join('?' for _ in project_ids)
        rows = db.execute(
            f"SELECT id, project_id FROM todos WHERE project_id IN ({placeholders}) AND status = 'done'",
            (*project_ids,)
        ).fetchall()
        deleted_ids = [r['id'] for r in rows]
        if deleted_ids:
            del_placeholders = ','.join('?' for _ in deleted_ids)
            required_todo_ids = {
                row["todo_id"] for row in db.execute(
                    f"SELECT DISTINCT todo_id FROM todo_attachments WHERE todo_id IN ({del_placeholders})",
                    deleted_ids,
                ).fetchall()
            }
            with AttachmentCleanupBatch(deleted_ids, required_todo_ids=required_todo_ids) as cleanup:
                db.execute(f"DELETE FROM reminders WHERE todo_id IN ({del_placeholders})", deleted_ids)
                db.execute(f"DELETE FROM todos WHERE id IN ({del_placeholders})", deleted_ids)
                commit_with_attachment_recovery(db, cleanup)
            for row in rows:
                await broadcast_change("todo_delete", {"id": row["id"]}, user_id, row["project_id"])
        return {"deleted_count": len(deleted_ids), "deleted_ids": deleted_ids}
