"""nia-todo: FastAPI backend"""

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from typing import Optional, List
from pathlib import Path
import json

from db import init_db, get_db, row_to_dict, now_iso

app = FastAPI(title="nia-todo", version="0.1.0")

# ─── Pydantic models ───────────────────────────────────────────────────────────

class TodoCreate(BaseModel):
    title: str
    description: str = ""
    priority: int = Field(default=3, ge=1, le=4)
    project_id: Optional[int] = None
    due_date: Optional[str] = None
    label_ids: List[int] = []
    remind_at: Optional[str] = None

class TodoUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    priority: Optional[int] = None
    project_id: Optional[int] = None
    due_date: Optional[str] = None
    status: Optional[str] = None
    label_ids: Optional[List[int]] = None
    remind_at: Optional[str] = None

class ProjectCreate(BaseModel):
    name: str
    color: str = "#6366f1"
    sort_order: int = 0

class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    sort_order: Optional[int] = None

class LabelCreate(BaseModel):
    name: str
    color: str = "#8b5cf6"

class LabelUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None

# ─── Helper ────────────────────────────────────────────────────────────────────

def fetch_todo(db, todo_id: int) -> Optional[dict]:
    row = db.execute(
        "SELECT t.*, p.name as project_name FROM todos t LEFT JOIN projects p ON t.project_id = p.id WHERE t.id = ?",
        (todo_id,)
    ).fetchone()
    if not row:
        return None
    d = row_to_dict(row)
    # labels
    label_rows = db.execute(
        "SELECT l.id, l.name, l.color FROM labels l JOIN todo_labels tl ON l.id = tl.label_id WHERE tl.todo_id = ?",
        (todo_id,)
    ).fetchall()
    d['labels'] = [dict(r) for r in label_rows]
    # reminders
    rem_rows = db.execute(
        "SELECT id, remind_at, sent_at FROM reminders WHERE todo_id = ? ORDER BY remind_at",
        (todo_id,)
    ).fetchall()
    d['reminders'] = [dict(r) for r in rem_rows]
    return d

# ─── Init DB on startup ─────────────────────────────────────────────────────

@app.on_event("startup")
def on_startup():
    init_db()

# ─── Todos ────────────────────────────────────────────────────────────────────

@app.get("/api/todos")
def list_todos(status: Optional[str] = None, project_id: Optional[int] = None, label_id: Optional[int] = None):
    with get_db() as db:
        sql = """
            SELECT t.*, p.name as project_name FROM todos t
            LEFT JOIN projects p ON t.project_id = p.id
            WHERE t.status != 'archived'
        """
        params = []
        if status:
            sql += " AND t.status = ?"
            params.append(status)
        if project_id:
            sql += " AND t.project_id = ?"
            params.append(project_id)
        if label_id:
            sql += " AND t.id IN (SELECT todo_id FROM todo_labels WHERE label_id = ?)"
            params.append(label_id)
        sql += " ORDER BY CASE t.status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, t.priority, t.due_date IS NULL, t.due_date"
        rows = db.execute(sql, params).fetchall()
        result = []
        for r in rows:
            d = row_to_dict(r)
            tid = d['id']
            label_rows = db.execute(
                "SELECT l.id, l.name, l.color FROM labels l JOIN todo_labels tl ON l.id = tl.label_id WHERE tl.todo_id = ?",
                (tid,)
            ).fetchall()
            d['labels'] = [dict(x) for x in label_rows]
            result.append(d)
        return {"todos": result}

@app.post("/api/todos")
def create_todo(data: TodoCreate):
    with get_db() as db:
        c = db.execute(
            "INSERT INTO todos (title, description, priority, project_id, due_date, updated_at) VALUES (?,?,?,?,?,?)",
            (data.title, data.description, data.priority, data.project_id, data.due_date, now_iso())
        )
        todo_id = c.lastrowid
        for lid in data.label_ids:
            db.execute("INSERT INTO todo_labels (todo_id, label_id) VALUES (?,?)", (todo_id, lid))
        if data.remind_at:
            db.execute("INSERT INTO reminders (todo_id, remind_at) VALUES (?,?)", (todo_id, data.remind_at))
        db.commit()
        return fetch_todo(db, todo_id)

@app.get("/api/todos/{todo_id}")
def get_todo(todo_id: int):
    with get_db() as db:
        d = fetch_todo(db, todo_id)
        if not d:
            raise HTTPException(404, "Todo not found")
        return d

@app.patch("/api/todos/{todo_id}")
def update_todo(todo_id: int, data: TodoUpdate):
    with get_db() as db:
        existing = fetch_todo(db, todo_id)
        if not existing:
            raise HTTPException(404, "Todo not found")
        updates = {}
        for f in ["title","description","priority","project_id","due_date","status"]:
            v = getattr(data, f)
            if v is not None:
                updates[f] = v
        if updates:
            updates['updated_at'] = now_iso()
            if data.status == 'done' and existing['status'] != 'done':
                updates['completed_at'] = now_iso()
            elif data.status != 'done' and existing['status'] == 'done':
                updates['completed_at'] = None
            set_clause = ", ".join(f"{k}=:{k}" for k in updates)
            db.execute(f"UPDATE todos SET {set_clause} WHERE id = :id", {**updates, "id": todo_id})
        if data.label_ids is not None:
            db.execute("DELETE FROM todo_labels WHERE todo_id = ?", (todo_id,))
            for lid in data.label_ids:
                db.execute("INSERT INTO todo_labels (todo_id, label_id) VALUES (?,?)", (todo_id, lid))
        if data.remind_at is not None:
            db.execute("DELETE FROM reminders WHERE todo_id = ?", (todo_id,))
            if data.remind_at:
                db.execute("INSERT INTO reminders (todo_id, remind_at) VALUES (?,?)", (todo_id, data.remind_at))
        db.commit()
        return fetch_todo(db, todo_id)

@app.delete("/api/todos/{todo_id}")
def delete_todo(todo_id: int):
    with get_db() as db:
        db.execute("DELETE FROM todos WHERE id = ?", (todo_id,))
        db.commit()
        return {"deleted": todo_id}

# ─── Projects ────────────────────────────────────────────────────────────────

@app.get("/api/projects")
def list_projects():
    with get_db() as db:
        rows = db.execute("SELECT * FROM projects ORDER BY sort_order, id").fetchall()
        return {"projects": [dict(r) for r in rows]}

@app.post("/api/projects")
def create_project(data: ProjectCreate):
    with get_db() as db:
        c = db.execute(
            "INSERT INTO projects (name, color, sort_order, updated_at) VALUES (?,?,?,?)",
            (data.name, data.color, data.sort_order, now_iso())
        )
        db.commit()
        row = db.execute("SELECT * FROM projects WHERE id = ?", (c.lastrowid,)).fetchone()
        return dict(row)

@app.patch("/api/projects/{project_id}")
def update_project(project_id: int, data: ProjectUpdate):
    with get_db() as db:
        existing = db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        if not existing:
            raise HTTPException(404, "Project not found")
        updates = {}
        for f in ["name","color","sort_order"]:
            v = getattr(data, f)
            if v is not None:
                updates[f] = v
        if updates:
            updates['updated_at'] = now_iso()
            set_clause = ", ".join(f"{k}=:{k}" for k in updates)
            db.execute(f"UPDATE projects SET {set_clause} WHERE id = :id", {**updates, "id": project_id})
            db.commit()
        row = db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        return dict(row)

@app.delete("/api/projects/{project_id}")
def delete_project(project_id: int):
    with get_db() as db:
        db.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        db.commit()
        return {"deleted": project_id}

# ─── Labels ──────────────────────────────────────────────────────────────────

@app.get("/api/labels")
def list_labels():
    with get_db() as db:
        rows = db.execute("SELECT * FROM labels ORDER BY name").fetchall()
        return {"labels": [dict(r) for r in rows]}

@app.post("/api/labels")
def create_label(data: LabelCreate):
    with get_db() as db:
        c = db.execute("INSERT INTO labels (name, color) VALUES (?,?)", (data.name, data.color))
        db.commit()
        row = db.execute("SELECT * FROM labels WHERE id = ?", (c.lastrowid,)).fetchone()
        return dict(row)

@app.patch("/api/labels/{label_id}")
def update_label(label_id: int, data: LabelUpdate):
    with get_db() as db:
        existing = db.execute("SELECT * FROM labels WHERE id = ?", (label_id,)).fetchone()
        if not existing:
            raise HTTPException(404, "Label not found")
        updates = {}
        for f in ["name","color"]:
            v = getattr(data, f)
            if v is not None:
                updates[f] = v
        if updates:
            set_clause = ", ".join(f"{k}=:{k}" for k in updates)
            db.execute(f"UPDATE labels SET {set_clause} WHERE id = :id", {**updates, "id": label_id})
            db.commit()
        row = db.execute("SELECT * FROM labels WHERE id = ?", (label_id,)).fetchone()
        return dict(row)

@app.delete("/api/labels/{label_id}")
def delete_label(label_id: int):
    with get_db() as db:
        db.execute("DELETE FROM labels WHERE id = ?", (label_id,))
        db.commit()
        return {"deleted": label_id}

# ─── Reminders ───────────────────────────────────────────────────────────────

@app.get("/api/reminders")
def list_reminders(due_only: bool = False):
    with get_db() as db:
        sql = """
            SELECT r.*, t.title, t.status FROM reminders r
            JOIN todos t ON r.todo_id = t.id
            WHERE t.status IN ('pending','in_progress')
        """
        if due_only:
            sql += " AND r.remind_at <= datetime('now') AND r.sent_at IS NULL"
        sql += " ORDER BY r.remind_at"
        rows = db.execute(sql).fetchall()
        return {"reminders": [dict(r) for r in rows]}

@app.post("/api/reminders/{reminder_id}/sent")
def mark_reminder_sent(reminder_id: int):
    with get_db() as db:
        db.execute("UPDATE reminders SET sent_at = ? WHERE id = ?", (now_iso(), reminder_id))
        db.commit()
        return {"sent": reminder_id}

# ─── Dashboard / Stats ───────────────────────────────────────────────────────

@app.get("/api/dashboard")
def dashboard():
    with get_db() as db:
        total = db.execute("SELECT COUNT(*) FROM todos WHERE status != 'archived'").fetchone()[0]
        pending = db.execute("SELECT COUNT(*) FROM todos WHERE status = 'pending'").fetchone()[0]
        inprog = db.execute("SELECT COUNT(*) FROM todos WHERE status = 'in_progress'").fetchone()[0]
        done = db.execute("SELECT COUNT(*) FROM todos WHERE status = 'done'").fetchone()[0]
        overdue = db.execute(
            "SELECT COUNT(*) FROM todos WHERE status IN ('pending','in_progress') AND due_date < date('now')"
        ).fetchone()[0]
        due_today = db.execute(
            "SELECT COUNT(*) FROM todos WHERE status IN ('pending','in_progress') AND date(due_date) = date('now')"
        ).fetchone()[0]
        return {
            "total": total,
            "pending": pending,
            "in_progress": inprog,
            "done": done,
            "overdue": overdue,
            "due_today": due_today
        }

# ─── Static frontend ──────────────────────────────────────────────────────────

WEB_DIR = Path(__file__).parent / "../web"
if WEB_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(WEB_DIR / "static")), name="static")

    @app.get("/")
    def index():
        return FileResponse(str(WEB_DIR / "index.html"))

    @app.get("/{path:path}")
    def spa(path: str):
        f = WEB_DIR / path
        if f.exists() and f.is_file():
            return FileResponse(str(f))
        return FileResponse(str(WEB_DIR / "index.html"))
