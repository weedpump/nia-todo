"""nia-todo: Workspace endpoints"""

import json
import sqlite3
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from errors import api_error
from pydantic import BaseModel, Field

from db import get_db, now_iso
from routers.auth import require_auth
from services.utils import sanitize_text
from services.appearance import normalize_color, normalize_icon
from services.workspace_visibility import (
    MAX_WORKSPACE_MODULE_IDS,
    has_visible_registered_module,
    normalize_hidden_modules,
    workspace_payload,
)
from services.websocket import broadcast_change

router = APIRouter(prefix="/api/workspaces")


class WorkspaceCreate(BaseModel):
    name: str
    color: str = "#6366f1"
    icon: Optional[str] = None
    sort_order: int = 0
    hidden_modules: list[str] = Field(default_factory=list, max_length=MAX_WORKSPACE_MODULE_IDS)


class WorkspaceUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    icon: Optional[str] = None
    sort_order: Optional[int] = None
    hidden_modules: Optional[list[str]] = Field(default=None, max_length=MAX_WORKSPACE_MODULE_IDS)


def ensure_default_workspace(db, user_id: int) -> int:
    row = db.execute(
        "SELECT id FROM workspaces WHERE user_id = ? AND COALESCE(is_default, 0) = 1 ORDER BY id LIMIT 1",
        (user_id,),
    ).fetchone()
    if row:
        return row["id"]
    c = db.execute(
        "INSERT INTO workspaces (name, color, icon, sort_order, user_id, is_default, updated_at) VALUES (?, ?, ?, 0, ?, 1, ?)",
        ("Personal", "#10b981", "home", user_id, now_iso()),
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
        """INSERT INTO projects (name, color, icon, sort_order, user_id, workspace_id, is_inbox, updated_at)
           VALUES ('Inbox', '#64748b', 'inbox', 0, ?, ?, 1, ?)""",
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
        return {"workspaces": [workspace_payload(r) for r in rows]}


@router.post("")
async def create_workspace(data: WorkspaceCreate, user_id: int = Depends(require_auth)):
    data.name = sanitize_text(data.name)
    data.color = normalize_color(data.color)
    data.icon = normalize_icon(data.icon)
    data.hidden_modules = normalize_hidden_modules(data.hidden_modules)
    if data.hidden_modules and not has_visible_registered_module(data.hidden_modules):
        raise api_error(422, "workspace.modulesRequired", "At least one registered module must remain visible")
    if not data.name:
        raise api_error(422, "workspace.nameRequired", "Workspace name required")
    with get_db() as db:
        ensure_default_workspace(db, user_id)
        try:
            c = db.execute(
                "INSERT INTO workspaces (name, color, icon, sort_order, user_id, is_default, hidden_modules_json, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
                (data.name, data.color, data.icon, data.sort_order, user_id, json.dumps(data.hidden_modules, separators=(",", ":")), now_iso()),
            )
            workspace_id = c.lastrowid
            ensure_workspace_inbox(db, user_id, workspace_id)
            db.commit()
        except sqlite3.IntegrityError:
            raise api_error(409, "workspace.alreadyExists", "Workspace already exists")
        row = db.execute("SELECT * FROM workspaces WHERE id = ? AND user_id = ?", (workspace_id, user_id)).fetchone()
        workspace = workspace_payload(row)
        await broadcast_change("workspace_create", workspace, user_id)
        return workspace


@router.patch("/{workspace_id}")
async def update_workspace(workspace_id: int, data: WorkspaceUpdate, user_id: int = Depends(require_auth)):
    fields_set = getattr(data, "model_fields_set", getattr(data, "__fields_set__", set()))
    if data.name is not None:
        data.name = sanitize_text(data.name)
        if not data.name:
            raise api_error(422, "workspace.nameRequired", "Workspace name required")
    if "color" in fields_set:
        data.color = normalize_color(data.color)
    if "icon" in fields_set:
        data.icon = normalize_icon(data.icon)
    if "hidden_modules" in fields_set:
        data.hidden_modules = normalize_hidden_modules(data.hidden_modules)
        if data.hidden_modules and not has_visible_registered_module(data.hidden_modules):
            raise api_error(422, "workspace.modulesRequired", "At least one registered module must remain visible")
    with get_db() as db:
        existing = db.execute("SELECT * FROM workspaces WHERE id = ? AND user_id = ?", (workspace_id, user_id)).fetchone()
        if not existing:
            raise api_error(404, "workspace.notFound", "Workspace not found")
        updates = {}
        for field in ["name", "color", "icon", "sort_order"]:
            if field in fields_set:
                updates[field] = getattr(data, field)
        if "hidden_modules" in fields_set:
            updates["hidden_modules_json"] = json.dumps(data.hidden_modules, separators=(",", ":"))
        if updates:
            updates["updated_at"] = now_iso()
            set_clause = ", ".join(f"{key}=:{key}" for key in updates)
            try:
                db.execute(f"UPDATE workspaces SET {set_clause} WHERE id = :id", {**updates, "id": workspace_id})
                db.commit()
            except sqlite3.IntegrityError:
                raise api_error(409, "workspace.alreadyExists", "Workspace already exists")
        row = db.execute("SELECT * FROM workspaces WHERE id = ? AND user_id = ?", (workspace_id, user_id)).fetchone()
        workspace = workspace_payload(row)
        await broadcast_change("workspace_update", workspace, user_id)
        return workspace


@router.delete("/{workspace_id}")
async def delete_workspace(workspace_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        existing = db.execute("SELECT * FROM workspaces WHERE id = ? AND user_id = ?", (workspace_id, user_id)).fetchone()
        if not existing:
            raise api_error(404, "workspace.notFound", "Workspace not found")
        if existing["is_default"]:
            raise api_error(400, "workspace.defaultCannotBeDeleted", "Default workspace cannot be deleted")

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
        result = {"deleted": workspace_id, "moved_projects_to": default_id, "moved_projects": [dict(p) for p in projects]}
        await broadcast_change("workspace_delete", result, user_id)
        return result
