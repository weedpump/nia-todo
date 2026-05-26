"""nia-todo: Project endpoints"""

from typing import Optional
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
import sqlite3

from db import get_db, now_iso
from routers.auth import require_auth
from services.websocket import broadcast_change, broadcast_project_updates, get_project_view_for_user
from services.utils import sanitize_text
from services.appearance import normalize_color, normalize_icon
from services.sharing import can_access_project, can_edit_project, get_project_ids_for_user

router = APIRouter(prefix="/api/projects")


class ProjectCreate(BaseModel):
    name: str
    color: str = "#6366f1"
    icon: Optional[str] = None
    sort_order: int = 0
    parent_id: Optional[int] = None
    workspace_id: Optional[int] = None


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
    db.commit()
    return c.lastrowid


def get_user_inbox_project_id(db, owner_user_id: int, workspace_id: Optional[int] = None) -> Optional[int]:
    if workspace_id is not None:
        row = db.execute(
            """SELECT id FROM projects
               WHERE user_id = ? AND workspace_id = ? AND COALESCE(is_inbox, 0) = 1
               ORDER BY id LIMIT 1""",
            (owner_user_id, workspace_id),
        ).fetchone()
        if row:
            return row['id']
    row = db.execute(
        "SELECT id FROM projects WHERE user_id = ? AND COALESCE(is_inbox, 0) = 1 ORDER BY id LIMIT 1",
        (owner_user_id,)
    ).fetchone()
    return row['id'] if row else None


@router.get("")
def list_projects(user_id: int = Depends(require_auth)):
    with get_db() as db:
        own_rows = db.execute(
            "SELECT *, 0 as is_shared, 1 as is_owner FROM projects WHERE user_id = ? ORDER BY COALESCE(is_inbox, 0) DESC, parent_id, sort_order, id",
            (user_id,),
        ).fetchall()
        default_workspace_id = get_user_default_workspace_id(db, user_id)
        shared_rows = db.execute(
            """
            SELECT p.id, p.name, p.color, p.sort_order, p.created_at, max(p.updated_at, COALESCE(pm.updated_at, p.updated_at)) as updated_at, p.parent_id,
                   p.user_id, p.is_inbox, p.workspace_id as owner_workspace_id, p.icon,
                   COALESCE(pm.workspace_id, ?) as workspace_id,
                   1 as is_shared, 0 as is_owner, pm.id as member_id, pm.status as member_status,
                   u.username as owner_username, u.display_name as owner_display_name
            FROM projects p
            JOIN project_members pm ON pm.project_id = p.id
            JOIN users u ON u.id = p.user_id
            WHERE pm.user_id = ? AND pm.status = 'accepted'
            ORDER BY p.name
            """,
            (default_workspace_id, user_id),
        ).fetchall()
        projects = [dict(r) for r in own_rows] + [dict(r) for r in shared_rows]
        return {"projects": projects}


@router.post("")
async def create_project(data: ProjectCreate, user_id: int = Depends(require_auth)):
    data.name = sanitize_text(data.name)
    data.color = normalize_color(data.color)
    data.icon = normalize_icon(data.icon)
    with get_db() as db:
        workspace_id = data.workspace_id or get_user_default_workspace_id(db, user_id)
        workspace = db.execute("SELECT id FROM workspaces WHERE id = ? AND user_id = ?", (workspace_id, user_id)).fetchone()
        if not workspace:
            raise HTTPException(404, "Workspace not found")
        if data.parent_id is not None:
            parent = db.execute("SELECT * FROM projects WHERE id = ? AND user_id = ?", (data.parent_id, user_id)).fetchone()
            if not parent:
                raise HTTPException(404, "Parent project not found")
            if parent['workspace_id'] != workspace_id:
                raise HTTPException(400, "Parent project belongs to another workspace")
        try:
            c = db.execute(
                "INSERT INTO projects (name, color, icon, sort_order, parent_id, workspace_id, updated_at, user_id) VALUES (?,?,?,?,?,?,?,?)",
                (data.name, data.color, data.icon, data.sort_order, data.parent_id, workspace_id, now_iso(), user_id)
            )
            db.commit()
        except sqlite3.IntegrityError:
            raise HTTPException(409, "Project could not be saved")
        row = db.execute("SELECT *, 0 as is_shared, 1 as is_owner FROM projects WHERE id = ?", (c.lastrowid,)).fetchone()
        proj = dict(row)
        await broadcast_change("project_create", proj, user_id)
        return proj


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
        existing = db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        if not existing:
            raise HTTPException(404, "Project not found")
        is_owner = can_edit_project(db, project_id, user_id)
        member = None
        if not is_owner:
            member = db.execute(
                "SELECT * FROM project_members WHERE project_id = ? AND user_id = ? AND status = 'accepted'",
                (project_id, user_id),
            ).fetchone()
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
            row = db.execute(
                """
                SELECT p.id, p.name, p.color, p.sort_order, p.created_at, max(p.updated_at, COALESCE(pm.updated_at, p.updated_at)) as updated_at, p.parent_id,
                   p.user_id, p.is_inbox, p.workspace_id as owner_workspace_id, p.icon,
                   COALESCE(pm.workspace_id, ?) as workspace_id,
                       1 as is_shared, 0 as is_owner, pm.id as member_id, pm.status as member_status,
                       u.username as owner_username, u.display_name as owner_display_name
                FROM projects p
                JOIN project_members pm ON pm.project_id = p.id
                JOIN users u ON u.id = p.user_id
                WHERE p.id = ? AND pm.user_id = ? AND pm.status = 'accepted'
                """,
                (data.workspace_id, project_id, user_id),
            ).fetchone()
            proj = dict(row)
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
        if next_parent_id is not None:
            if next_parent_id == project_id:
                raise HTTPException(400, "Project cannot be its own parent")
            parent = db.execute("SELECT id, parent_id, workspace_id FROM projects WHERE id = ? AND user_id = ?", (next_parent_id, user_id)).fetchone()
            if not parent:
                raise HTTPException(404, "Parent project not found")
            if parent['workspace_id'] != target_workspace_id:
                raise HTTPException(400, "Parent project belongs to another workspace")
            current_check = next_parent_id
            while current_check is not None:
                ancestor = db.execute("SELECT parent_id FROM projects WHERE id = ? AND user_id = ?", (current_check, user_id)).fetchone()
                if ancestor and ancestor['parent_id'] == project_id:
                    raise HTTPException(400, "Circular dependency")
                current_check = ancestor['parent_id'] if ancestor else None

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
                        children = db.execute("SELECT id FROM projects WHERE parent_id = ? AND user_id = ?", (current_id, user_id)).fetchall()
                        for child in children:
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
        with get_db() as view_db:
            updated_projects = [get_project_view_for_user(view_db, pid, user_id) for pid in changed_project_ids]
        updated_projects = [project for project in updated_projects if project is not None]
        proj = dict(updated_projects[0]) if updated_projects else dict(existing)
        if len(updated_projects) > 1:
            proj["updated_projects"] = [dict(project) for project in updated_projects]
        await broadcast_project_updates(changed_project_ids, user_id)
        return proj


@router.delete("/{project_id}")
async def delete_project(project_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
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
            children = db.execute("SELECT id FROM projects WHERE parent_id = ? AND user_id = ?", (pid, user_id)).fetchall()
            for child in children:
                queue.append(child['id'])
        placeholders = ','.join('?' for _ in to_delete)
        recipient_rows = db.execute(
            f"SELECT DISTINCT user_id FROM project_members WHERE project_id IN ({placeholders}) AND status = 'accepted'",
            tuple(to_delete),
        ).fetchall()
        recipient_ids = {row['user_id'] for row in recipient_rows}

        for pid in to_delete:
            todo_rows = db.execute("SELECT id, user_id FROM todos WHERE project_id = ?", (pid,)).fetchall()
            for todo in todo_rows:
                inbox_id = get_user_inbox_project_id(db, todo['user_id'], proj['workspace_id']) if todo['user_id'] is not None else None
                db.execute(
                    "UPDATE todos SET project_id = ?, section_id = NULL WHERE id = ?",
                    (inbox_id, todo['id'])
                )
        for pid in to_delete:
            db.execute("DELETE FROM sections WHERE project_id = ?", (pid,))
        for pid in reversed(to_delete):
            db.execute("DELETE FROM projects WHERE id = ?", (pid,))
        db.commit()
        await broadcast_change("project_delete", {"id": project_id, "deleted_ids": to_delete}, user_id, recipient_ids=recipient_ids)
        return {"deleted": project_id, "deleted_ids": to_delete}


@router.post("/{project_id}/clear-done")
async def clear_done_todos(project_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        proj = db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        if not proj:
            raise HTTPException(404, "Project not found")
        if not can_access_project(db, project_id, user_id):
            raise HTTPException(403, "Not authorized")
        project_ids = [project_id]
        queue = [project_id]
        while queue:
            pid = queue.pop(0)
            children = db.execute("SELECT id FROM projects WHERE parent_id = ? AND user_id = ?", (pid, user_id)).fetchall()
            for child in children:
                project_ids.append(child['id'])
                queue.append(child['id'])
        placeholders = ','.join('?' for _ in project_ids)
        rows = db.execute(
            f"SELECT id FROM todos WHERE project_id IN ({placeholders}) AND status = 'done'",
            (*project_ids,)
        ).fetchall()
        deleted_ids = [r['id'] for r in rows]
        if deleted_ids:
            del_placeholders = ','.join('?' for _ in deleted_ids)
            db.execute(f"DELETE FROM reminders WHERE todo_id IN ({del_placeholders})", deleted_ids)
            db.execute(f"DELETE FROM todos WHERE id IN ({del_placeholders})", deleted_ids)
            db.commit()
            for tid in deleted_ids:
                await broadcast_change("todo_delete", {"id": tid}, user_id, project_id)
        return {"deleted_count": len(deleted_ids), "deleted_ids": deleted_ids}
