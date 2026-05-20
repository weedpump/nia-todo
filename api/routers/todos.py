"""nia-todo: Todo endpoints"""

from datetime import datetime
from typing import Optional
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field

from db import get_db, row_to_dict, now_iso
from routers.auth import require_auth
from services.websocket import broadcast_change
from services.utils import sanitize_text
from services.sharing import can_access_project, can_manage_todos, get_project_ids_for_user

router = APIRouter(prefix="/api/todos")


# ─── Pydantic Models ─────────────────────────────────────────────────────────

class TodoCreate(BaseModel):
    title: str
    description: str = ""
    priority: int = Field(default=3, ge=1, le=4)
    status: str = "pending"
    project_id: Optional[int] = None
    section_id: Optional[int] = None
    due_date: Optional[str] = None
    remind_at: Optional[str] = None

class TodoUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    priority: Optional[int] = None
    status: Optional[str] = None
    project_id: Optional[int] = None
    section_id: Optional[int] = None
    due_date: Optional[str] = None
    remind_at: Optional[str] = None


# ─── Helpers ───────────────────────────────────────────────────────────────────

ALLOWED_TODO_STATUSES = {"pending", "in_progress", "done"}


def get_user_inbox_project_id(db, user_id: int) -> Optional[int]:
    row = db.execute(
        "SELECT id FROM projects WHERE user_id = ? AND COALESCE(is_inbox, 0) = 1 ORDER BY id LIMIT 1",
        (user_id,)
    ).fetchone()
    return row['id'] if row else None

def fetch_todo(db, todo_id: int, reminder_user_id: Optional[int] = None) -> Optional[dict]:
    row = db.execute(
        """SELECT t.*, p.name as project_name, s.name as section_name
           FROM todos t
           LEFT JOIN projects p ON t.project_id = p.id
           LEFT JOIN sections s ON t.section_id = s.id
           WHERE t.id = ?""",
        (todo_id,)
    ).fetchone()
    if not row:
        return None
    d = row_to_dict(row)
    if reminder_user_id is None:
        rem_rows = db.execute(
            "SELECT id, remind_at, sent_at FROM reminders WHERE todo_id = ? ORDER BY remind_at",
            (todo_id,)
        ).fetchall()
    else:
        rem_rows = db.execute(
            """SELECT id, remind_at, sent_at FROM reminders
               WHERE todo_id = ? AND (user_id = ? OR user_id IS NULL)
               ORDER BY remind_at""",
            (todo_id, reminder_user_id)
        ).fetchall()
    d['reminders'] = [dict(r) for r in rem_rows]
    return d


def _todo_project_access(db, todo: dict, user_id: int) -> bool:
    project_id = todo.get('project_id')
    if project_id is None:
        return todo.get('user_id') == user_id
    return can_access_project(db, project_id, user_id) or todo.get('user_id') == user_id


def _validate_todo_target(db, project_id: Optional[int], section_id: Optional[int], user_id: int):
    if project_id is not None and not can_manage_todos(db, project_id, user_id):
        raise HTTPException(403, "Not authorized")
    if section_id is not None:
        row = db.execute("SELECT project_id FROM sections WHERE id = ?", (section_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Section not found")
        if project_id is None or row['project_id'] != project_id:
            raise HTTPException(400, "Section does not belong to the selected project")
        if not can_manage_todos(db, row['project_id'], user_id):
            raise HTTPException(403, "Not authorized")


def _validate_datetime(value: Optional[str], field_name: str):
    if value in (None, ""):
        return
    try:
        parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except ValueError:
        raise HTTPException(422, f"Invalid {field_name}")
    if parsed.year < 1900 or parsed.year > 9999:
        raise HTTPException(422, f"Invalid {field_name}")


def _validate_todo_dates(data):
    _validate_datetime(getattr(data, 'due_date', None), 'due_date')
    _validate_datetime(getattr(data, 'remind_at', None), 'remind_at')


def _validate_todo_status(status: Optional[str]):
    if status is not None and status not in ALLOWED_TODO_STATUSES:
        raise HTTPException(422, "Invalid status")


# ─── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("")
def list_todos(status: Optional[str] = None, project_id: Optional[int] = None, section_id: Optional[int] = None, user_id: int = Depends(require_auth)):
    with get_db() as db:
        if project_id is not None and not can_access_project(db, project_id, user_id):
            raise HTTPException(404, "Project not found")
        if section_id is not None:
            section = db.execute("SELECT project_id FROM sections WHERE id = ?", (section_id,)).fetchone()
            if not section:
                raise HTTPException(404, "Section not found")
            if project_id is not None and section['project_id'] != project_id:
                raise HTTPException(400, "Section does not belong to the selected project")
            if not can_access_project(db, section['project_id'], user_id):
                raise HTTPException(404, "Section not found")

        project_ids = get_project_ids_for_user(db, user_id)
        params: list = []
        sql = """
            SELECT t.*, p.name as project_name, s.name as section_name FROM todos t
            LEFT JOIN projects p ON t.project_id = p.id
            LEFT JOIN sections s ON t.section_id = s.id
            WHERE t.status != 'archived'
        """
        if project_ids:
            placeholders = ','.join('?' for _ in project_ids)
            sql += f" AND (t.user_id = ? OR t.project_id IN ({placeholders}))"
            params.extend([user_id, *project_ids])
        else:
            sql += " AND t.user_id = ?"
            params.append(user_id)
        if status:
            sql += " AND t.status = ?"
            params.append(status)
        if project_id is not None:
            sql += " AND t.project_id = ?"
            params.append(project_id)
        if section_id is not None:
            sql += " AND t.section_id = ?"
            params.append(section_id)
        sql += " ORDER BY CASE t.status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, t.priority, t.due_date IS NULL, t.due_date"
        rows = db.execute(sql, params).fetchall()
        return {"todos": [row_to_dict(r) for r in rows]}

@router.post("")
async def create_todo(data: TodoCreate, user_id: int = Depends(require_auth)):
    data.title = sanitize_text(data.title)
    data.description = sanitize_text(data.description)
    _validate_todo_dates(data)
    _validate_todo_status(data.status)
    with get_db() as db:
        if data.project_id is None and data.section_id is None:
            data.project_id = get_user_inbox_project_id(db, user_id)
        _validate_todo_target(db, data.project_id, data.section_id, user_id)
        now = now_iso()
        completed_at = now if data.status == 'done' else None
        c = db.execute(
            """INSERT INTO todos
               (title, description, priority, status, project_id, section_id, due_date, completed_at, updated_at, user_id)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (data.title, data.description, data.priority, data.status, data.project_id, data.section_id, data.due_date, completed_at, now, user_id)
        )
        todo_id = c.lastrowid
        if data.remind_at:
            db.execute("INSERT INTO reminders (todo_id, remind_at, user_id) VALUES (?,?,?)", (todo_id, data.remind_at, user_id))
        db.commit()
        todo = fetch_todo(db, todo_id, user_id)
        await broadcast_change("todo_create", todo, user_id, data.project_id)
        return todo

@router.get("/{todo_id}")
def get_todo(todo_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        d = fetch_todo(db, todo_id, user_id)
        if not d:
            raise HTTPException(404, "Todo not found")
        if not _todo_project_access(db, d, user_id):
            raise HTTPException(403, "Not authorized")
        return d

@router.patch("/{todo_id}")
async def update_todo(todo_id: int, data: TodoUpdate, user_id: int = Depends(require_auth)):
    if data.title is not None:
        data.title = sanitize_text(data.title)
    if data.description is not None:
        data.description = sanitize_text(data.description)
    _validate_todo_dates(data)
    _validate_todo_status(data.status)
    with get_db() as db:
        existing = fetch_todo(db, todo_id, user_id)
        if not existing:
            raise HTTPException(404, "Todo not found")
        if not _todo_project_access(db, existing, user_id):
            raise HTTPException(403, "Not authorized")
        dumped = data.model_dump(exclude_unset=True)
        target_project_id = dumped.get('project_id', existing.get('project_id'))
        target_section_id = dumped.get('section_id', existing.get('section_id'))
        _validate_todo_target(db, target_project_id, target_section_id, user_id)

        updates = {}
        for f in ["title", "description", "priority", "project_id", "section_id", "due_date", "status"]:
            if f in dumped:
                updates[f] = dumped[f]
        if updates:
            updates['updated_at'] = now_iso()
            if data.status == 'done' and existing['status'] != 'done':
                updates['completed_at'] = now_iso()
            elif data.status != 'done' and existing['status'] == 'done':
                updates['completed_at'] = None
            allowed_cols = {"title", "description", "priority", "project_id", "section_id", "due_date", "status", "completed_at", "updated_at"}
            safe_updates = {k:v for k,v in updates.items() if k in allowed_cols}
            set_clause = ", ".join(f"{k}=:{k}" for k in safe_updates)
            db.execute(f"UPDATE todos SET {set_clause} WHERE id = :id", {**safe_updates, "id": todo_id})
        if 'remind_at' in dumped:
            if existing.get('user_id') == user_id:
                db.execute(
                    "DELETE FROM reminders WHERE todo_id = ? AND (user_id = ? OR user_id IS NULL)",
                    (todo_id, user_id)
                )
            else:
                db.execute("DELETE FROM reminders WHERE todo_id = ? AND user_id = ?", (todo_id, user_id))
            if data.remind_at:
                db.execute("INSERT INTO reminders (todo_id, remind_at, user_id) VALUES (?,?,?)", (todo_id, data.remind_at, user_id))
        db.commit()
        todo = fetch_todo(db, todo_id, user_id)
        await broadcast_change("todo_update", todo, user_id, todo.get('project_id'))
        return todo

@router.delete("/{todo_id}")
async def delete_todo(todo_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        existing = fetch_todo(db, todo_id, user_id)
        if not existing:
            raise HTTPException(404, "Todo not found")
        if not _todo_project_access(db, existing, user_id):
            raise HTTPException(403, "Not authorized")
        db.execute("DELETE FROM todos WHERE id = ?", (todo_id,))
        db.commit()
        await broadcast_change("todo_delete", {"id": todo_id}, user_id, existing.get('project_id'))
        return {"deleted": todo_id}
