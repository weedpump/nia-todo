"""nia-todo: Section endpoints"""

from typing import Optional
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from db import get_db, row_to_dict, now_iso
from routers.auth import require_auth
from services.websocket import broadcast_change
from services.utils import sanitize_text
from services.sharing import can_access_project, can_manage_todos

router = APIRouter(prefix="/api/sections")


class SectionCreate(BaseModel):
    name: str
    sort_order: int = 0

class SectionUpdate(BaseModel):
    name: Optional[str] = None
    sort_order: Optional[int] = None


@router.get("")
def list_all_sections(user_id: int = Depends(require_auth)):
    with get_db() as db:
        rows = db.execute(
            """
            SELECT s.* FROM sections s
            JOIN projects p ON s.project_id = p.id
            LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ? AND pm.status = 'accepted'
            WHERE p.user_id = ? OR pm.user_id IS NOT NULL
            ORDER BY s.sort_order, s.id
            """,
            (user_id, user_id)
        ).fetchall()
        return {"sections": [dict(r) for r in rows]}

@router.get("/by-project/{project_id}")
def list_sections(project_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        if not can_access_project(db, project_id, user_id):
            raise HTTPException(404, "Project not found")
        rows = db.execute(
            "SELECT * FROM sections WHERE project_id = ? ORDER BY sort_order, id",
            (project_id,)
        ).fetchall()
        return {"sections": [dict(r) for r in rows]}

@router.post("/by-project/{project_id}")
async def create_section(project_id: int, data: SectionCreate, user_id: int = Depends(require_auth)):
    data.name = sanitize_text(data.name)
    with get_db() as db:
        if not can_manage_todos(db, project_id, user_id):
            raise HTTPException(403, "Not authorized")
        c = db.execute(
            "INSERT INTO sections (project_id, name, sort_order, created_at, updated_at, user_id) VALUES (?,?,?,?,?,?)",
            (project_id, data.name, data.sort_order, now_iso(), now_iso(), user_id)
        )
        db.commit()
        row = db.execute("SELECT * FROM sections WHERE id = ?", (c.lastrowid,)).fetchone()
        section = dict(row)
        await broadcast_change("section_create", section, user_id, project_id)
        return section

@router.patch("/{section_id}")
async def update_section(section_id: int, data: SectionUpdate, user_id: int = Depends(require_auth)):
    if data.name is not None:
        data.name = sanitize_text(data.name)
    with get_db() as db:
        existing = db.execute(
            """
            SELECT s.* FROM sections s
            JOIN projects p ON s.project_id = p.id
            LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ? AND pm.status = 'accepted'
            WHERE s.id = ? AND (p.user_id = ? OR pm.user_id IS NOT NULL)
            """,
            (user_id, section_id, user_id),
        ).fetchone()
        if not existing:
            raise HTTPException(404, "Section not found")
        updates = {}
        for f in ["name", "sort_order"]:
            v = getattr(data, f)
            if v is not None:
                updates[f] = v
        if updates:
            updates['updated_at'] = now_iso()
            set_clause = ", ".join(f"{k}=:{k}" for k in updates)
            db.execute(f"UPDATE sections SET {set_clause} WHERE id = :id", {**updates, "id": section_id})
            db.commit()
        row = db.execute("SELECT * FROM sections WHERE id = ?", (section_id,)).fetchone()
        section = dict(row)
        await broadcast_change("section_update", section, user_id, section['project_id'])
        return section

@router.delete("/{section_id}")
async def delete_section(section_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        existing = db.execute(
            """
            SELECT s.* FROM sections s
            JOIN projects p ON s.project_id = p.id
            LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ? AND pm.status = 'accepted'
            WHERE s.id = ? AND (p.user_id = ? OR pm.user_id IS NOT NULL)
            """,
            (user_id, section_id, user_id),
        ).fetchone()
        if not existing:
            raise HTTPException(404, "Section not found")
        db.execute("UPDATE todos SET section_id = NULL WHERE section_id = ?", (section_id,))
        db.execute("DELETE FROM sections WHERE id = ?", (section_id,))
        db.commit()
        await broadcast_change("section_delete", {"id": section_id}, user_id, existing['project_id'])
        return {"deleted": section_id}
