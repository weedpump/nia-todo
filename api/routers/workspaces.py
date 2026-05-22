"""nia-todo: Workspace endpoints"""

from typing import Optional
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
import sqlite3

from db import get_db, now_iso
from routers.auth import require_auth
from services.utils import sanitize_text

router = APIRouter(prefix="/api/workspaces")


class WorkspaceCreate(BaseModel):
    name: str
    color: str = "#6366f1"
    sort_order: int = 0


class WorkspaceUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    sort_order: Optional[int] = None


def ensure_default_workspace(db, user_id: int) -> int:
    row = db.execute(
        "SELECT id FROM workspaces WHERE user_id = ? AND COALESCE(is_default, 0) = 1 ORDER BY id LIMIT 1",
        (user_id,),
    ).fetchone()
    if row:
        return row["id"]
    c = db.execute(
        "INSERT INTO workspaces (name, color, sort_order, user_id, is_default, updated_at) VALUES (?, ?, 0, ?, 1, ?)",
        ("Privat", "#10b981", user_id, now_iso()),
    )
    db.execute("UPDATE projects SET workspace_id = ? WHERE user_id = ? AND workspace_id IS NULL", (c.lastrowid, user_id))
    db.commit()
    return c.lastrowid


def ensure_workspace_inbox(db, user_id: int, workspace_id: int) -> int:
    row = db.execute(
        """SELECT id FROM projects
           WHERE user_id = ? AND workspace_id = ? AND COALESCE(is_inbox, 0) = 1
           ORDER BY id LIMIT 1""",
        (user_id, workspace_id),
    ).fetchone()
    if row:
        return row["id"]
    c = db.execute(
        """INSERT INTO projects (name, color, sort_order, user_id, workspace_id, is_inbox, updated_at)
           VALUES ('Inbox', '#64748b', 0, ?, ?, 1, ?)""",
        (user_id, workspace_id, now_iso()),
    )
    return c.lastrowid


@router.get("")
def list_workspaces(user_id: int = Depends(require_auth)):
    with get_db() as db:
        default_id = ensure_default_workspace(db, user_id)
        ensure_workspace_inbox(db, user_id, default_id)
        rows = db.execute(
            "SELECT * FROM workspaces WHERE user_id = ? ORDER BY COALESCE(is_default, 0) DESC, sort_order, name, id",
            (user_id,),
        ).fetchall()
        return {"workspaces": [dict(r) for r in rows]}


@router.post("")
def create_workspace(data: WorkspaceCreate, user_id: int = Depends(require_auth)):
    data.name = sanitize_text(data.name)
    if not data.name:
        raise HTTPException(422, "Workspace name required")
    with get_db() as db:
        ensure_default_workspace(db, user_id)
        try:
            c = db.execute(
                "INSERT INTO workspaces (name, color, sort_order, user_id, is_default, updated_at) VALUES (?, ?, ?, ?, 0, ?)",
                (data.name, data.color, data.sort_order, user_id, now_iso()),
            )
            workspace_id = c.lastrowid
            ensure_workspace_inbox(db, user_id, workspace_id)
            db.commit()
        except sqlite3.IntegrityError:
            raise HTTPException(409, "Workspace already exists")
        row = db.execute("SELECT * FROM workspaces WHERE id = ? AND user_id = ?", (workspace_id, user_id)).fetchone()
        return dict(row)


@router.patch("/{workspace_id}")
def update_workspace(workspace_id: int, data: WorkspaceUpdate, user_id: int = Depends(require_auth)):
    if data.name is not None:
        data.name = sanitize_text(data.name)
        if not data.name:
            raise HTTPException(422, "Workspace name required")
    with get_db() as db:
        existing = db.execute("SELECT * FROM workspaces WHERE id = ? AND user_id = ?", (workspace_id, user_id)).fetchone()
        if not existing:
            raise HTTPException(404, "Workspace not found")
        fields_set = getattr(data, "model_fields_set", getattr(data, "__fields_set__", set()))
        updates = {}
        for field in ["name", "color", "sort_order"]:
            if field in fields_set:
                updates[field] = getattr(data, field)
        if updates:
            updates["updated_at"] = now_iso()
            set_clause = ", ".join(f"{key}=:{key}" for key in updates)
            try:
                db.execute(f"UPDATE workspaces SET {set_clause} WHERE id = :id", {**updates, "id": workspace_id})
                db.commit()
            except sqlite3.IntegrityError:
                raise HTTPException(409, "Workspace already exists")
        row = db.execute("SELECT * FROM workspaces WHERE id = ? AND user_id = ?", (workspace_id, user_id)).fetchone()
        return dict(row)


@router.delete("/{workspace_id}")
def delete_workspace(workspace_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        existing = db.execute("SELECT * FROM workspaces WHERE id = ? AND user_id = ?", (workspace_id, user_id)).fetchone()
        if not existing:
            raise HTTPException(404, "Workspace not found")
        if existing["is_default"]:
            raise HTTPException(400, "Default workspace cannot be deleted")

        default_id = ensure_default_workspace(db, user_id)
        default_inbox_id = ensure_workspace_inbox(db, user_id, default_id)
        source_inbox_id = ensure_workspace_inbox(db, user_id, workspace_id)

        db.execute(
            "UPDATE todos SET project_id = ?, section_id = NULL WHERE user_id = ? AND project_id = ?",
            (default_inbox_id, user_id, source_inbox_id),
        )
        db.execute("DELETE FROM sections WHERE project_id = ?", (source_inbox_id,))
        db.execute("DELETE FROM projects WHERE id = ? AND user_id = ?", (source_inbox_id, user_id))

        projects = db.execute(
            """SELECT id FROM projects
               WHERE user_id = ? AND workspace_id = ?
               ORDER BY CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END, parent_id, sort_order, id""",
            (user_id, workspace_id),
        ).fetchall()
        for project in projects:
            db.execute(
                "UPDATE projects SET workspace_id = ?, updated_at = ? WHERE id = ? AND user_id = ?",
                (default_id, now_iso(), project["id"], user_id),
            )

        db.execute("DELETE FROM workspaces WHERE id = ? AND user_id = ?", (workspace_id, user_id))
        db.commit()
        return {"deleted": workspace_id, "moved_projects_to": default_id, "moved_projects": [dict(p) for p in projects]}
