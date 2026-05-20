"""nia-todo: Project endpoints"""

from typing import Optional
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from db import get_db, now_iso
from routers.auth import require_auth
from services.websocket import broadcast_change
from services.utils import sanitize_text
from services.sharing import can_access_project, can_edit_project, get_project_ids_for_user

router = APIRouter(prefix="/api/projects")


class ProjectCreate(BaseModel):
    name: str
    color: str = "#6366f1"
    sort_order: int = 0
    parent_id: Optional[int] = None


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    sort_order: Optional[int] = None
    parent_id: Optional[int] = None


@router.get("")
def list_projects(user_id: int = Depends(require_auth)):
    with get_db() as db:
        own_rows = db.execute(
            "SELECT *, 0 as is_shared, 1 as is_owner FROM projects WHERE user_id = ? ORDER BY parent_id, sort_order, id",
            (user_id,),
        ).fetchall()
        shared_rows = db.execute(
            """
            SELECT p.*, 1 as is_shared, 0 as is_owner, pm.id as member_id, pm.status as member_status
            FROM projects p
            JOIN project_members pm ON pm.project_id = p.id
            WHERE pm.user_id = ? AND pm.status = 'accepted'
            ORDER BY p.name
            """,
            (user_id,),
        ).fetchall()
        projects = [dict(r) for r in own_rows] + [dict(r) for r in shared_rows]
        return {"projects": projects}


@router.post("")
async def create_project(data: ProjectCreate, user_id: int = Depends(require_auth)):
    data.name = sanitize_text(data.name)
    with get_db() as db:
        if data.parent_id is not None:
            parent = db.execute("SELECT * FROM projects WHERE id = ? AND user_id = ?", (data.parent_id, user_id)).fetchone()
            if not parent:
                raise HTTPException(404, "Parent project not found")
        c = db.execute(
            "INSERT INTO projects (name, color, sort_order, parent_id, updated_at, user_id) VALUES (?,?,?,?,?,?)",
            (data.name, data.color, data.sort_order, data.parent_id, now_iso(), user_id)
        )
        db.commit()
        row = db.execute("SELECT *, 0 as is_shared, 1 as is_owner FROM projects WHERE id = ?", (c.lastrowid,)).fetchone()
        proj = dict(row)
        await broadcast_change("project_create", proj, user_id)
        return proj


@router.patch("/{project_id}")
async def update_project(project_id: int, data: ProjectUpdate, user_id: int = Depends(require_auth)):
    if data.name is not None:
        data.name = sanitize_text(data.name)
    with get_db() as db:
        existing = db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        if not existing:
            raise HTTPException(404, "Project not found")
        if not can_edit_project(db, project_id, user_id):
            raise HTTPException(403, "Only the owner can edit this project")
        if data.parent_id is not None:
            if data.parent_id == project_id:
                raise HTTPException(400, "Project cannot be its own parent")
            current_check = data.parent_id
            while current_check is not None:
                ancestor = db.execute("SELECT parent_id FROM projects WHERE id = ? AND user_id = ?", (current_check, user_id)).fetchone()
                if ancestor and ancestor['parent_id'] == project_id:
                    raise HTTPException(400, "Circular dependency")
                current_check = ancestor['parent_id'] if ancestor else None
        updates = {}
        for f in ["name", "color", "sort_order", "parent_id"]:
            v = getattr(data, f)
            if v is not None:
                updates[f] = v
        if updates:
            updates['updated_at'] = now_iso()
            allowed_cols = {"name", "color", "sort_order", "parent_id", "updated_at"}
            safe_updates = {k: v for k, v in updates.items() if k in allowed_cols}
            set_clause = ", ".join(f"{k}=:{k}" for k in safe_updates)
            db.execute(f"UPDATE projects SET {set_clause} WHERE id = :id", {**safe_updates, "id": project_id})
            db.commit()
        row = db.execute("SELECT *, CASE WHEN user_id = ? THEN 1 ELSE 0 END as is_owner, 0 as is_shared FROM projects WHERE id = ?", (user_id, project_id)).fetchone()
        proj = dict(row)
        await broadcast_change("project_update", proj, user_id, project_id)
        return proj


@router.delete("/{project_id}")
async def delete_project(project_id: int, user_id: int = Depends(require_auth)):
    if project_id == 1:
        raise HTTPException(400, "Inbox cannot be deleted")
    with get_db() as db:
        proj = db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        if not proj:
            raise HTTPException(404, "Project not found")
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
        for pid in to_delete:
            db.execute("UPDATE todos SET project_id = 1, section_id = NULL WHERE project_id = ?", (pid,))
        for pid in to_delete:
            db.execute("DELETE FROM sections WHERE project_id = ?", (pid,))
        for pid in reversed(to_delete):
            db.execute("DELETE FROM projects WHERE id = ?", (pid,))
        db.commit()
        await broadcast_change("project_delete", {"id": project_id}, user_id, project_id)
        return {"deleted": project_id}


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
