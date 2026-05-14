"""nia-todo: FastAPI backend"""

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from typing import Optional, List
from pathlib import Path
import json
import asyncio

from db import init_db, get_db, row_to_dict, now_iso

app = FastAPI(title="nia-todo-dev", version="0.2.1")

# ─── WebSocket Connection Manager ──────────────────────────────────────────────

class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        print(f"[WS] Client connected. Total: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            print(f"[WS] Client disconnected. Total: {len(self.active_connections)}")

    async def send_personal_message(self, message: dict, websocket: WebSocket):
        try:
            await websocket.send_json(message)
        except Exception:
            pass

    async def broadcast(self, message: dict):
        disconnected = []
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception:
                disconnected.append(connection)
        for conn in disconnected:
            if conn in self.active_connections:
                self.active_connections.remove(conn)

manager = ConnectionManager()

# ─── Pydantic models ───────────────────────────────────────────────────────────

class TodoCreate(BaseModel):
    title: str
    description: str = ""
    priority: int = Field(default=3, ge=1, le=4)
    project_id: Optional[int] = None
    section_id: Optional[int] = None
    due_date: Optional[str] = None
    remind_at: Optional[str] = None

class TodoUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    priority: Optional[int] = None
    project_id: Optional[int] = None
    section_id: Optional[int] = None
    due_date: Optional[str] = None
    status: Optional[str] = None
    remind_at: Optional[str] = None

class ProjectCreate(BaseModel):
    name: str
    color: str = "#6366f1"
    sort_order: int = 0

class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    sort_order: Optional[int] = None

class SectionCreate(BaseModel):
    name: str
    sort_order: int = 0

class SectionUpdate(BaseModel):
    name: Optional[str] = None
    sort_order: Optional[int] = None

# ─── Helper ────────────────────────────────────────────────────────────────────

def fetch_todo(db, todo_id: int) -> Optional[dict]:
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
    # reminders
    rem_rows = db.execute(
        "SELECT id, remind_at, sent_at FROM reminders WHERE todo_id = ? ORDER BY remind_at",
        (todo_id,)
    ).fetchall()
    d['reminders'] = [dict(r) for r in rem_rows]
    return d

# ─── WebSocket Endpoint ────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type", "")
            if msg_type == "ping":
                await manager.send_personal_message({"type": "pong", "ts": now_iso()}, websocket)
            elif msg_type == "sync_request":
                # Client requested full sync -> send all todos + projects
                with get_db() as db:
                    todos_rows = db.execute("""
                        SELECT t.*, p.name as project_name, s.name as section_name FROM todos t
                        LEFT JOIN projects p ON t.project_id = p.id
                        LEFT JOIN sections s ON t.section_id = s.id
                        WHERE t.status != 'archived'
                        ORDER BY CASE t.status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, t.priority, t.due_date IS NULL, t.due_date
                    """).fetchall()
                    todos_out = []
                    for r in todos_rows:
                        d = row_to_dict(r)
                        d['labels'] = []
                        todos_out.append(d)
                    projects_rows = db.execute("SELECT * FROM projects ORDER BY sort_order, id").fetchall()
                    await manager.send_personal_message({
                        "type": "sync_response",
                        "todos": todos_out,
                        "projects": [dict(r) for r in projects_rows]
                    }, websocket)
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        print(f"[WS] Error: {e}")
        manager.disconnect(websocket)

async def broadcast_change(event_type: str, payload: dict):
    await manager.broadcast({"type": event_type, "payload": payload})

# ─── Init DB on startup ─────────────────────────────────────────────────────

@app.on_event("startup")
def on_startup():
    init_db()

# ─── Todos ────────────────────────────────────────────────────────────────────

@app.get("/api/todos")
def list_todos(status: Optional[str] = None, project_id: Optional[int] = None, section_id: Optional[int] = None):
    with get_db() as db:
        sql = """
            SELECT t.*, p.name as project_name, s.name as section_name FROM todos t
            LEFT JOIN projects p ON t.project_id = p.id
            LEFT JOIN sections s ON t.section_id = s.id
            WHERE t.status != 'archived'
        """
        params = []
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
        result = []
        for r in rows:
            d = row_to_dict(r)
            tid = d['id']
            d['labels'] = []
            result.append(d)
        return {"todos": result}

@app.post("/api/todos")
async def create_todo(data: TodoCreate):
    with get_db() as db:
        c = db.execute(
            "INSERT INTO todos (title, description, priority, project_id, section_id, due_date, updated_at) VALUES (?,?,?,?,?,?,?)",
            (data.title, data.description, data.priority, data.project_id, data.section_id, data.due_date, now_iso())
        )
        todo_id = c.lastrowid
        if data.remind_at:
            db.execute("INSERT INTO reminders (todo_id, remind_at) VALUES (?,?)", (todo_id, data.remind_at))
        db.commit()
        todo = fetch_todo(db, todo_id)
        await broadcast_change("todo_create", todo)
        return todo

@app.get("/api/todos/{todo_id}")
def get_todo(todo_id: int):
    with get_db() as db:
        d = fetch_todo(db, todo_id)
        if not d:
            raise HTTPException(404, "Todo not found")
        return d

@app.patch("/api/todos/{todo_id}")
async def update_todo(todo_id: int, data: TodoUpdate):
    with get_db() as db:
        existing = fetch_todo(db, todo_id)
        if not existing:
            raise HTTPException(404, "Todo not found")
        updates = {}
        dumped = data.model_dump(exclude_unset=True)
        for f in ["title","description","priority","project_id","section_id","due_date","status"]:
            if f in dumped:
                updates[f] = dumped[f]
        if updates:
            updates['updated_at'] = now_iso()
            if data.status == 'done' and existing['status'] != 'done':
                updates['completed_at'] = now_iso()
            elif data.status != 'done' and existing['status'] == 'done':
                updates['completed_at'] = None
            set_clause = ", ".join(f"{k}=:{k}" for k in updates)
            db.execute(f"UPDATE todos SET {set_clause} WHERE id = :id", {**updates, "id": todo_id})
        if data.remind_at is not None:
            db.execute("DELETE FROM reminders WHERE todo_id = ?", (todo_id,))
            if data.remind_at:
                db.execute("INSERT INTO reminders (todo_id, remind_at) VALUES (?,?)", (todo_id, data.remind_at))
        db.commit()
        todo = fetch_todo(db, todo_id)
        await broadcast_change("todo_update", todo)
        return todo

@app.delete("/api/todos/{todo_id}")
async def delete_todo(todo_id: int):
    with get_db() as db:
        db.execute("DELETE FROM todos WHERE id = ?", (todo_id,))
        db.commit()
        await broadcast_change("todo_delete", {"id": todo_id})
        return {"deleted": todo_id}

# ─── Projects ────────────────────────────────────────────────────────────────

@app.get("/api/projects")
def list_projects():
    with get_db() as db:
        rows = db.execute("SELECT * FROM projects ORDER BY sort_order, id").fetchall()
        return {"projects": [dict(r) for r in rows]}

@app.post("/api/projects")
async def create_project(data: ProjectCreate):
    with get_db() as db:
        c = db.execute(
            "INSERT INTO projects (name, color, sort_order, updated_at) VALUES (?,?,?,?)",
            (data.name, data.color, data.sort_order, now_iso())
        )
        db.commit()
        row = db.execute("SELECT * FROM projects WHERE id = ?", (c.lastrowid,)).fetchone()
        proj = dict(row)
        await broadcast_change("project_create", proj)
        return proj

@app.patch("/api/projects/{project_id}")
async def update_project(project_id: int, data: ProjectUpdate):
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
        proj = dict(row)
        await broadcast_change("project_update", proj)
        return proj

@app.delete("/api/projects/{project_id}")
async def delete_project(project_id: int):
    if project_id == 1:
        raise HTTPException(400, "Inbox cannot be deleted")
    with get_db() as db:
        # Move todos to inbox before deleting project
        db.execute("UPDATE todos SET project_id = 1, section_id = NULL WHERE project_id = ?", (project_id,))
        # Also delete associated sections
        db.execute("DELETE FROM sections WHERE project_id = ?", (project_id,))
        db.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        db.commit()
        await broadcast_change("project_delete", {"id": project_id})
        return {"deleted": project_id}

# ─── Sections ───────────────────────────────────────────────────────────────

@app.get("/api/projects/{project_id}/sections")
def list_sections(project_id: int):
    with get_db() as db:
        rows = db.execute(
            "SELECT * FROM sections WHERE project_id = ? ORDER BY sort_order, id",
            (project_id,)
        ).fetchall()
        return {"sections": [dict(r) for r in rows]}

@app.post("/api/projects/{project_id}/sections")
def create_section(project_id: int, data: SectionCreate):
    with get_db() as db:
        # Verify project exists
        proj = db.execute("SELECT id FROM projects WHERE id = ?", (project_id,)).fetchone()
        if not proj:
            raise HTTPException(404, "Project not found")
        c = db.execute(
            "INSERT INTO sections (project_id, name, sort_order, created_at) VALUES (?,?,?,?)",
            (project_id, data.name, data.sort_order, now_iso())
        )
        db.commit()
        row = db.execute("SELECT * FROM sections WHERE id = ?", (c.lastrowid,)).fetchone()
        return dict(row)

@app.patch("/api/sections/{section_id}")
def update_section(section_id: int, data: SectionUpdate):
    with get_db() as db:
        existing = db.execute("SELECT * FROM sections WHERE id = ?", (section_id,)).fetchone()
        if not existing:
            raise HTTPException(404, "Section not found")
        updates = {}
        for f in ["name", "sort_order"]:
            v = getattr(data, f)
            if v is not None:
                updates[f] = v
        if updates:
            set_clause = ", ".join(f"{k}=:{k}" for k in updates)
            db.execute(f"UPDATE sections SET {set_clause} WHERE id = :id", {**updates, "id": section_id})
            db.commit()
        row = db.execute("SELECT * FROM sections WHERE id = ?", (section_id,)).fetchone()
        return dict(row)

@app.delete("/api/sections/{section_id}")
def delete_section(section_id: int):
    with get_db() as db:
        existing = db.execute("SELECT * FROM sections WHERE id = ?", (section_id,)).fetchone()
        if not existing:
            raise HTTPException(404, "Section not found")
        # Move todos to unsorted (section_id = NULL)
        db.execute("UPDATE todos SET section_id = NULL WHERE section_id = ?", (section_id,))
        db.execute("DELETE FROM sections WHERE id = ?", (section_id,))
        db.commit()
        return {"deleted": section_id}

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

    @app.get("/sw.js")
    @app.head("/sw.js")
    def sw_js():
        return FileResponse(str(WEB_DIR / "sw.js"))

    @app.get("/favicon.ico")
    @app.head("/favicon.ico")
    def favicon():
        if (WEB_DIR / "favicon.ico").exists():
            return FileResponse(str(WEB_DIR / "favicon.ico"))
        return FileResponse(str(WEB_DIR / "static" / "icons" / "icon-192.png"))

    @app.get("/{path:path}")
    def spa(path: str):
        f = WEB_DIR / path
        if f.exists() and f.is_file():
            return FileResponse(str(f))
        return FileResponse(str(WEB_DIR / "index.html"))
