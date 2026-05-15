"""nia-todo: FastAPI backend"""

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Header, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from typing import Optional, List
from pathlib import Path
import json
import asyncio
import secrets
import time
import sqlite3

import bcrypt
import jwt as pyjwt
from db import init_db, get_db, row_to_dict, now_iso
from migrate import run_migrations

# Migrationen beim Import ausführen (vor App-Start)
run_migrations()

app = FastAPI(title="nia-todo", version="0.4.0")

# ─── Auth / Session Helpers ───────────────────────────────────────────────────

# In-memory session store: token -> user_id (legacy fallback)
sessions = {}

# ─── Password Validation ──────────────────────────────────────────────────────

import re

def validate_password(password: str, min_length: int = 8) -> str:
    """Validates password meets security requirements. Returns error message or empty string if valid."""
    if len(password) < min_length:
        return f"Passwort muss mindestens {min_length} Zeichen lang sein"
    if not re.search(r'[A-Z]', password):
        return "Passwort muss mindestens einen Großbuchstaben enthalten"
    if not re.search(r'[a-z]', password):
        return "Passwort muss mindestens einen Kleinbuchstaben enthalten"
    if not re.search(r'\d', password):
        return "Passwort muss mindestens eine Ziffer enthalten"
    if not re.search(r'[!@#$%^&*()_+\-=\[\]{};\':"\\|,.<>\/?]', password):
        return "Passwort muss mindestens ein Sonderzeichen enthalten"
    return ""

def validate_admin_password(password: str) -> str:
    """Admin passwords require at least 12 characters."""
    return validate_password(password, min_length=12)

# ─── JWT Configuration ──────────────────────────────────────────────────────────

JWT_ALGORITHM = "HS256"
JWT_EXPIRY_DAYS = 7

def get_jwt_secret(db) -> str:
    """Get or create JWT secret from admin_config."""
    try:
        row = db.execute("SELECT jwt_secret FROM admin_config WHERE id = 1").fetchone()
        if row and row['jwt_secret']:
            return row['jwt_secret']
    except sqlite3.OperationalError:
        # Column doesn't exist yet, add it
        db.execute("ALTER TABLE admin_config ADD COLUMN jwt_secret TEXT")
        db.commit()
    # Generate new secret
    secret = secrets.token_urlsafe(32)
    db.execute(
        """INSERT INTO admin_config (id, jwt_secret, created_at)
           VALUES (1, ?, datetime('now'))
           ON CONFLICT(id) DO UPDATE SET jwt_secret = excluded.jwt_secret""",
        (secret,)
    )
    db.commit()
    return secret

def create_jwt_token(user: dict, db) -> str:
    """Create a JWT token with user info and token_version."""
    secret = get_jwt_secret(db)
    now = int(time.time())
    payload = {
        "user_id": user['id'],
        "username": user['username'],
        "token_version": user.get('token_version', 1),
        "is_admin": bool(user.get('is_admin', False)),
        "iat": now,
        "exp": now + (JWT_EXPIRY_DAYS * 86400)
    }
    return pyjwt.encode(payload, secret, algorithm=JWT_ALGORITHM)

def decode_jwt_token(token: str, db) -> Optional[dict]:
    """Decode and validate a JWT token."""
    if not token:
        return None
    try:
        secret = get_jwt_secret(db)
        payload = pyjwt.decode(token, secret, algorithms=[JWT_ALGORITHM])
        
        # Verify token_version matches DB
        user_id = payload.get('user_id')
        db_version = db.execute(
            "SELECT token_version FROM users WHERE id = ?",
            (user_id,)
        ).fetchone()
        
        if not db_version:
            return None
        if db_version['token_version'] != payload.get('token_version'):
            return None  # Token revoked
            
        return payload
    except pyjwt.ExpiredSignatureError:
        return None
    except pyjwt.InvalidTokenError:
        return None

def get_current_user(token: Optional[str] = None) -> Optional[int]:
    """Extract user_id from JWT token (legacy session fallback supported)."""
    if not token:
        return None
    # Legacy session fallback
    legacy_user = sessions.get(token)
    if legacy_user:
        return legacy_user
    # JWT
    with get_db() as db:
        payload = decode_jwt_token(token, db)
        if payload:
            return payload.get('user_id')
    return None

def require_auth(authorization: Optional[str] = Header(None), x_session_token: Optional[str] = Header(None)) -> int:
    """Dependency: validate JWT from Authorization header or X-Session-Token."""
    token = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
    elif x_session_token:
        token = x_session_token
    
    user_id = get_current_user(token)
    if not user_id:
        raise HTTPException(401, "Not authenticated")
    return user_id

def verify_user_credentials(db, username: str, password: str) -> Optional[dict]:
    row = db.execute(
        "SELECT id, username, display_name, password_hash, is_admin, token_version FROM users WHERE username = ?",
        (username,)
    ).fetchone()
    if not row:
        return None
    stored_hash = row['password_hash']
    if bcrypt.checkpw(password.encode(), stored_hash.encode()):
        return dict(row)
    return None

class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    sort_order: Optional[int] = None
    parent_id: Optional[int] = None

class SectionCreate(BaseModel):
    name: str
    sort_order: int = 0

class SectionUpdate(BaseModel):
    name: Optional[str] = None
    sort_order: Optional[int] = None

class LoginRequest(BaseModel):
    username: str
    password: str

class UserResponse(BaseModel):
    id: int
    username: str
    display_name: str

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
    status: Optional[str] = None
    project_id: Optional[int] = None
    section_id: Optional[int] = None
    due_date: Optional[str] = None
    remind_at: Optional[str] = None

class ProjectCreate(BaseModel):
    name: str
    color: str = "#6366f1"
    sort_order: int = 0
    parent_id: Optional[int] = None

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

# ─── WebSocket ConnectionManager ─────────────────────────────────────────────────

class ConnectionManager:
    def __init__(self):
        # user_id -> list of websockets
        self.connections: dict[int, list[WebSocket]] = {}
        # websocket -> user_id mapping
        self.ws_users: dict[WebSocket, int] = {}

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        # Don't add to connections yet - wait for auth

    def disconnect(self, websocket: WebSocket):
        user_id = self.ws_users.pop(websocket, None)
        if user_id and user_id in self.connections:
            if websocket in self.connections[user_id]:
                self.connections[user_id].remove(websocket)
            if not self.connections[user_id]:
                del self.connections[user_id]

    def register_auth(self, websocket: WebSocket, user_id: int):
        self.ws_users[websocket] = user_id
        if user_id not in self.connections:
            self.connections[user_id] = []
        self.connections[user_id].append(websocket)

    async def send_personal_message(self, message: dict, websocket: WebSocket):
        await websocket.send_json(message)

    async def broadcast_to_user(self, user_id: int, message: dict):
        """Send message only to connections of a specific user."""
        if user_id not in self.connections:
            return
        for connection in self.connections[user_id][:]:  # copy to allow removal
            try:
                await connection.send_json(message)
            except:
                pass

    async def broadcast(self, message: dict):
        """Broadcast to all authenticated connections (legacy)."""
        for user_id, connections in list(self.connections.items()):
            for connection in connections[:]:
                try:
                    await connection.send_json(message)
                except:
                    pass

manager = ConnectionManager()

# ─── WebSocket Endpoint ────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    ws_user_id = None
    
    # Check token from query params
    token = websocket.query_params.get('token')
    if token:
        user_id = get_current_user(token)
        if user_id:
            ws_user_id = user_id
    
    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type", "")
            
            if msg_type == "auth":
                token = data.get("token")
                user_id = get_current_user(token)
                if user_id:
                    ws_user_id = user_id
                    manager.register_auth(websocket, user_id)  # Register for user-specific broadcasts
                    await manager.send_personal_message({"type": "auth_ok", "user_id": user_id}, websocket)
                else:
                    await manager.send_personal_message({"type": "auth_fail"}, websocket)
            elif msg_type == "ping":
                await manager.send_personal_message({"type": "pong", "ts": now_iso()}, websocket)
            elif msg_type == "sync_request":
                if not ws_user_id:
                    await manager.send_personal_message({"type": "error", "message": "Not authenticated"}, websocket)
                    continue
                # Client requested full sync -> send user's todos + projects
                with get_db() as db:
                    todos_rows = db.execute("""
                        SELECT t.*, p.name as project_name, s.name as section_name FROM todos t
                        LEFT JOIN projects p ON t.project_id = p.id
                        LEFT JOIN sections s ON t.section_id = s.id
                        WHERE t.user_id = ? AND t.status != 'archived'
                        ORDER BY CASE t.status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, t.priority, t.due_date IS NULL, t.due_date
                    """, (ws_user_id,)).fetchall()
                    todos_out = []
                    for r in todos_rows:
                        d = row_to_dict(r)
                        d['labels'] = []
                        todos_out.append(d)
                    projects_rows = db.execute("SELECT * FROM projects WHERE user_id = ? ORDER BY sort_order, id", (ws_user_id,)).fetchall()
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

    except Exception as e:
        print(f"[WS] Error: {e}")
        manager.disconnect(websocket)

async def broadcast_change(event_type: str, payload: dict, user_id: int):
    """Broadcast change only to the user who owns the data."""
    await manager.broadcast_to_user(user_id, {"type": event_type, "payload": payload})

# ─── Init DB on startup ─────────────────────────────────────────────────────

@app.on_event("startup")
def on_startup():
    init_db()

# ─── Auth Endpoints (JWT) ─────────────────────────────────────────────────────

@app.post("/api/login")
def login(data: LoginRequest):
    with get_db() as db:
        user = verify_user_credentials(db, data.username, data.password)
        if not user:
            raise HTTPException(401, "Invalid credentials")
        # Generate JWT with versioned secrets
        token = create_jwt_token(user, db)
        return {
            "access_token": token,
            "token_type": "bearer",
            "user": {
                "id": user['id'],
                "username": user['username'],
                "display_name": user['display_name'],
                "is_admin": bool(user.get('is_admin', False))
            }
        }

@app.post("/api/logout")
def logout(authorization: Optional[str] = Header(None), x_session_token: Optional[str] = Header(None)):
    """Logout: invalidate all tokens by incrementing token_version."""
    token = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
    elif x_session_token:
        token = x_session_token
    
    with get_db() as db:
        payload = decode_jwt_token(token, db)
        if payload:
            user_id = payload.get('user_id')
            db.execute(
                "UPDATE users SET token_version = token_version + 1 WHERE id = ?",
                (user_id,)
            )
            db.commit()
        # Also remove legacy session
        if x_session_token and x_session_token in sessions:
            del sessions[x_session_token]
    
    return {"logged_out": True}

@app.get("/api/me")
def me(authorization: Optional[str] = Header(None), x_session_token: Optional[str] = Header(None)):
    token = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
    elif x_session_token:
        token = x_session_token
    
    with get_db() as db:
        payload = decode_jwt_token(token, db)
        if not payload:
            # Legacy fallback
            user_id = sessions.get(token) if token else None
            if not user_id:
                raise HTTPException(401, "Not authenticated")
        else:
            user_id = payload.get('user_id')
        
        user = db.execute(
            "SELECT id, username, display_name, is_admin FROM users WHERE id = ?",
            (user_id,)
        ).fetchone()
        if not user:
            raise HTTPException(404, "User not found")
        return dict(user)

# ─── Admin / Setup Endpoints (NO auth required for setup) ─────────────────────

class SetupStatusResponse(BaseModel):
    setup_complete: bool
    has_users: bool

class AdminSetupRequest(BaseModel):
    admin_password: str

class FirstUserRequest(BaseModel):
    username: str
    password: str
    display_name: str

class CreateUserRequest(BaseModel):
    username: str
    password: str
    display_name: str

class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str

class ChangeAdminPasswordRequest(BaseModel):
    old_password: str
    new_password: str

class ResetUserPasswordRequest(BaseModel):
    new_password: str

@app.get("/api/setup/status")
def setup_status():
    with get_db() as db:
        config = db.execute("SELECT setup_complete FROM admin_config WHERE id = 1").fetchone()
        user_count = db.execute("SELECT COUNT(*) as c FROM users").fetchone()['c']
        return {
            "setup_complete": bool(config['setup_complete']) if config else False,
            "has_users": user_count > 0
        }

@app.post("/api/setup/admin")
def setup_admin(data: AdminSetupRequest):
    # Validate admin password
    error = validate_admin_password(data.admin_password)
    if error:
        raise HTTPException(400, error)
    
    with get_db() as db:
        # Check if already set up
        config = db.execute("SELECT setup_complete FROM admin_config WHERE id = 1").fetchone()
        if config and config['setup_complete']:
            raise HTTPException(400, "Setup already complete")
        
        # Hash admin password
        admin_hash = bcrypt.hashpw(data.admin_password.encode(), bcrypt.gensalt()).decode()
        
        # Insert or update admin config
        db.execute(
            """INSERT INTO admin_config (id, setup_complete, admin_token_hash, created_at)
               VALUES (1, 0, ?, datetime('now'))
               ON CONFLICT(id) DO UPDATE SET
               admin_token_hash = excluded.admin_token_hash""",
            (admin_hash,)
        )
        db.commit()
        return {"message": "Admin password set"}

@app.post("/api/setup/first-user")
def setup_first_user(data: FirstUserRequest):
    # Validate user password (min 8 chars)
    error = validate_password(data.password)
    if error:
        raise HTTPException(400, error)
    
    with get_db() as db:
        # Check if users exist
        user_count = db.execute("SELECT COUNT(*) as c FROM users").fetchone()['c']
        if user_count > 0:
            raise HTTPException(400, "Users already exist. Use /api/admin/users")
        
        # Create first user as admin
        password_hash = bcrypt.hashpw(data.password.encode(), bcrypt.gensalt()).decode()
        c = db.execute(
            "INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?, ?, ?, 1)",
            (data.username, data.display_name, password_hash)
        )
        user_id = c.lastrowid
        
        # Assign all unassigned data to this user
        db.execute("UPDATE projects SET user_id = ? WHERE user_id IS NULL", (user_id,))
        db.execute("UPDATE todos SET user_id = ? WHERE user_id IS NULL", (user_id,))
        db.execute("UPDATE sections SET user_id = ? WHERE user_id IS NULL", (user_id,))
        
        # Mark setup as complete
        db.execute("UPDATE admin_config SET setup_complete = 1 WHERE id = 1")
        db.commit()
        
        return {
            "message": "First user created",
            "user": {
                "id": user_id,
                "username": data.username,
                "display_name": data.display_name
            }
        }

# ─── Admin Endpoints (require admin token via X-Admin-Token header) ───────────

def verify_admin_token(x_admin_token: Optional[str] = Header(None)) -> bool:
    if not x_admin_token:
        return False
    with get_db() as db:
        config = db.execute("SELECT admin_token_hash FROM admin_config WHERE id = 1").fetchone()
        if not config or not config['admin_token_hash']:
            return False
        return bcrypt.checkpw(x_admin_token.encode(), config['admin_token_hash'].encode())

def require_admin(x_admin_token: Optional[str] = Header(None)):
    if not verify_admin_token(x_admin_token):
        raise HTTPException(403, "Invalid admin token")
    return True

@app.post("/api/admin/users")
def create_user(data: CreateUserRequest, _: bool = Depends(require_admin)):
    # Validate user password (min 8 chars)
    error = validate_password(data.password)
    if error:
        raise HTTPException(400, error)
    
    with get_db() as db:
        # Check if username exists
        existing = db.execute("SELECT id FROM users WHERE username = ?", (data.username,)).fetchone()
        if existing:
            raise HTTPException(409, "Username already exists")
        
        password_hash = bcrypt.hashpw(data.password.encode(), bcrypt.gensalt()).decode()
        c = db.execute(
            "INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?, ?, ?, 0)",
            (data.username, data.display_name, password_hash)
        )
        user_id = c.lastrowid
        db.commit()
        
        return {
            "id": user_id,
            "username": data.username,
            "display_name": data.display_name,
            "created_at": now_iso()
        }

@app.get("/api/admin/users")
def list_users(_: bool = Depends(require_admin)):
    with get_db() as db:
        rows = db.execute(
            "SELECT id, username, display_name, is_admin, created_at FROM users ORDER BY id"
        ).fetchall()
        return {"users": [dict(r) for r in rows]}

@app.delete("/api/admin/users/{user_id}")
def delete_user(user_id: int, x_admin_token: Optional[str] = Header(None), _: bool = Depends(require_admin)):
    with get_db() as db:
        # Prevent deleting yourself - need to check who the admin is
        # For simplicity, prevent deleting user id 1 (first admin)
        user = db.execute("SELECT is_admin FROM users WHERE id = ?", (user_id,)).fetchone()
        if not user:
            raise HTTPException(404, "User not found")
        if user['is_admin']:
            raise HTTPException(400, "Cannot delete admin user")

        db.execute("DELETE FROM users WHERE id = ?", (user_id,))
        db.commit()
        return {"deleted": user_id}

# ─── Password Change Endpoints ────────────────────────────────────────────────

@app.post("/api/me/change-password")
def change_own_password(data: ChangePasswordRequest, user_id: int = Depends(require_auth)):
    """User changes their own password. Invalidates all existing JWTs."""
    # Validate new password strength
    error = validate_password(data.new_password)
    if error:
        raise HTTPException(400, error)

    with get_db() as db:
        # Get user's current password hash
        row = db.execute(
            "SELECT password_hash FROM users WHERE id = ?",
            (user_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "User not found")

        # Verify old password
        if not bcrypt.checkpw(data.old_password.encode(), row['password_hash'].encode()):
            raise HTTPException(401, "Altes Passwort ist falsch")

        # Hash new password
        new_hash = bcrypt.hashpw(data.new_password.encode(), bcrypt.gensalt()).decode()

        # Update password and increment token_version (invalidates all JWTs)
        db.execute(
            "UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?",
            (new_hash, user_id)
        )
        db.commit()

    return {"message": "Passwort geändert. Bitte melde dich erneut an."}

@app.post("/api/admin/change-password")
def change_admin_password(data: ChangeAdminPasswordRequest, _: bool = Depends(require_admin)):
    """Admin changes the admin password (admin_config.admin_token_hash)."""
    # Validate new password strength
    error = validate_admin_password(data.new_password)
    if error:
        raise HTTPException(400, error)

    with get_db() as db:
        # Get current admin hash
        config = db.execute("SELECT admin_token_hash FROM admin_config WHERE id = 1").fetchone()
        if not config or not config['admin_token_hash']:
            raise HTTPException(500, "Admin-Konfiguration nicht gefunden")

        # Verify old password
        if not bcrypt.checkpw(data.old_password.encode(), config['admin_token_hash'].encode()):
            raise HTTPException(401, "Altes Admin-Passwort ist falsch")

        # Hash new admin password
        new_hash = bcrypt.hashpw(data.new_password.encode(), bcrypt.gensalt()).decode()

        db.execute(
            "UPDATE admin_config SET admin_token_hash = ? WHERE id = 1",
            (new_hash,)
        )
        db.commit()

    return {"message": "Admin-Passwort geändert. Bitte melde dich erneut an."}

@app.post("/api/admin/users/{user_id}/change-password")
def admin_change_user_password(user_id: int, data: ResetUserPasswordRequest, _: bool = Depends(require_admin)):
    """Admin changes any user's password. Invalidates that user's sessions."""
    # Validate new password strength
    error = validate_password(data.new_password)
    if error:
        raise HTTPException(400, error)

    with get_db() as db:
        # Check user exists
        user = db.execute(
            "SELECT id FROM users WHERE id = ?",
            (user_id,)
        ).fetchone()
        if not user:
            raise HTTPException(404, "User not found")

        # Hash new password and increment token_version
        new_hash = bcrypt.hashpw(data.new_password.encode(), bcrypt.gensalt()).decode()
        db.execute(
            "UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?",
            (new_hash, user_id)
        )
        db.commit()

    return {"message": "Passwort geändert. Der Benutzer muss sich erneut anmelden."}

# ─── Modified Auth ───────────────────────────────────────────────────────────

@app.get("/api/me")
def me(x_session_token: Optional[str] = Header(None)):
    user_id = get_current_user(x_session_token)
    if not user_id:
        raise HTTPException(401, "Not authenticated")
    with get_db() as db:
        user = db.execute(
            "SELECT id, username, display_name, is_admin FROM users WHERE id = ?",
            (user_id,)
        ).fetchone()
        if not user:
            raise HTTPException(404, "User not found")
        return dict(user)

# ─── Todos ────────────────────────────────────────────────────────────────────

@app.get("/api/todos")
def list_todos(status: Optional[str] = None, project_id: Optional[int] = None, section_id: Optional[int] = None, user_id: int = Depends(require_auth)):
    with get_db() as db:
        sql = """
            SELECT t.*, p.name as project_name, s.name as section_name FROM todos t
            LEFT JOIN projects p ON t.project_id = p.id
            LEFT JOIN sections s ON t.section_id = s.id
            WHERE t.user_id = ? AND t.status != 'archived'
        """
        params = [user_id]
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
async def create_todo(data: TodoCreate, user_id: int = Depends(require_auth)):
    with get_db() as db:
        c = db.execute(
            "INSERT INTO todos (title, description, priority, project_id, section_id, due_date, updated_at, user_id) VALUES (?,?,?,?,?,?,?,?)",
            (data.title, data.description, data.priority, data.project_id, data.section_id, data.due_date, now_iso(), user_id)
        )
        todo_id = c.lastrowid
        if data.remind_at:
            db.execute("INSERT INTO reminders (todo_id, remind_at, user_id) VALUES (?,?,?)", (todo_id, data.remind_at, user_id))
        db.commit()
        todo = fetch_todo(db, todo_id)
        await broadcast_change("todo_create", todo, user_id)
        return todo

@app.get("/api/todos/{todo_id}")
def get_todo(todo_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        d = fetch_todo(db, todo_id)
        if not d:
            raise HTTPException(404, "Todo not found")
        if d.get('user_id') != user_id:
            raise HTTPException(403, "Not authorized")
        return d

@app.patch("/api/todos/{todo_id}")
async def update_todo(todo_id: int, data: TodoUpdate, user_id: int = Depends(require_auth)):
    with get_db() as db:
        existing = fetch_todo(db, todo_id)
        if not existing:
            raise HTTPException(404, "Todo not found")
        if existing.get('user_id') != user_id:
            raise HTTPException(403, "Not authorized")
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
                db.execute("INSERT INTO reminders (todo_id, remind_at, user_id) VALUES (?,?,?)", (todo_id, data.remind_at, user_id))
        db.commit()
        todo = fetch_todo(db, todo_id)
        await broadcast_change("todo_update", todo, user_id)
        return todo

@app.delete("/api/todos/{todo_id}")
async def delete_todo(todo_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        existing = fetch_todo(db, todo_id)
        if not existing:
            raise HTTPException(404, "Todo not found")
        if existing.get('user_id') != user_id:
            raise HTTPException(403, "Not authorized")
        db.execute("DELETE FROM todos WHERE id = ?", (todo_id,))
        db.commit()
        await broadcast_change("todo_delete", {"id": todo_id}, user_id)
        return {"deleted": todo_id}

# ─── Projects ────────────────────────────────────────────────────────────────

@app.get("/api/projects")
def list_projects(user_id: int = Depends(require_auth)):
    with get_db() as db:
        rows = db.execute("SELECT * FROM projects WHERE user_id = ? ORDER BY parent_id, sort_order, id", (user_id,)).fetchall()
        return {"projects": [dict(r) for r in rows]}

@app.post("/api/projects")
async def create_project(data: ProjectCreate, user_id: int = Depends(require_auth)):
    with get_db() as db:
        # Validate parent_id: cannot be self and must exist and belong to user
        if data.parent_id is not None:
            parent = db.execute("SELECT * FROM projects WHERE id = ? AND user_id = ?", (data.parent_id, user_id)).fetchone()
            if not parent:
                raise HTTPException(404, "Parent project not found")
        
        c = db.execute(
            "INSERT INTO projects (name, color, sort_order, parent_id, updated_at, user_id) VALUES (?,?,?,?,?,?)",
            (data.name, data.color, data.sort_order, data.parent_id, now_iso(), user_id)
        )
        db.commit()
        row = db.execute("SELECT * FROM projects WHERE id = ?", (c.lastrowid,)).fetchone()
        proj = dict(row)
        await broadcast_change("project_create", proj, user_id)
        return proj

@app.patch("/api/projects/{project_id}")
async def update_project(project_id: int, data: ProjectUpdate, user_id: int = Depends(require_auth)):
    with get_db() as db:
        existing = db.execute("SELECT * FROM projects WHERE id = ? AND user_id = ?", (project_id, user_id)).fetchone()
        if not existing:
            raise HTTPException(404, "Project not found")
        
        # Validate parent_id update: prevent circular dependencies
        if data.parent_id is not None:
            if data.parent_id == project_id:
                raise HTTPException(400, "Project cannot be its own parent")
            # Check if target parent is a descendant of this project (would create cycle)
            current_check = data.parent_id
            while current_check is not None:
                ancestor = db.execute("SELECT parent_id FROM projects WHERE id = ? AND user_id = ?", (current_check, user_id)).fetchone()
                if ancestor and ancestor['parent_id'] == project_id:
                    raise HTTPException(400, "Circular dependency: target parent is a descendant of this project")
                current_check = ancestor['parent_id'] if ancestor else None
        
        updates = {}
        for f in ["name","color","sort_order","parent_id"]:
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
        await broadcast_change("project_update", proj, user_id)
        return proj

@app.delete("/api/projects/{project_id}")
async def delete_project(project_id: int, user_id: int = Depends(require_auth)):
    if project_id == 1:
        raise HTTPException(400, "Inbox cannot be deleted")
    with get_db() as db:
        # Check ownership
        proj = db.execute("SELECT * FROM projects WHERE id = ? AND user_id = ?", (project_id, user_id)).fetchone()
        if not proj:
            raise HTTPException(404, "Project not found")
        # Find all descendant project IDs (recursive)
        to_delete = []
        queue = [project_id]
        while queue:
            pid = queue.pop(0)
            to_delete.append(pid)
            children = db.execute("SELECT id FROM projects WHERE parent_id = ? AND user_id = ?", (pid, user_id)).fetchall()
            for child in children:
                queue.append(child['id'])
        
        # Move all todos from all projects to inbox
        for pid in to_delete:
            db.execute("UPDATE todos SET project_id = 1, section_id = NULL WHERE project_id = ? AND user_id = ?", (pid, user_id))
        
        # Delete sections and projects (order matters for FK constraints)
        for pid in to_delete:
            db.execute("DELETE FROM sections WHERE project_id = ?", (pid,))
        for pid in reversed(to_delete):  # Children first
            db.execute("DELETE FROM projects WHERE id = ?", (pid,))
        
        db.commit()
        await broadcast_change("project_delete", {"id": project_id}, user_id)
        return {"deleted": project_id}

# ─── Sections ───────────────────────────────────────────────────────────────

@app.get("/api/projects/{project_id}/sections")
def list_sections(project_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        # Check ownership
        proj = db.execute("SELECT * FROM projects WHERE id = ? AND user_id = ?", (project_id, user_id)).fetchone()
        if not proj:
            raise HTTPException(404, "Project not found")
        rows = db.execute(
            "SELECT * FROM sections WHERE project_id = ? ORDER BY sort_order, id",
            (project_id,)
        ).fetchall()
        return {"sections": [dict(r) for r in rows]}

@app.post("/api/projects/{project_id}/sections")
def create_section(project_id: int, data: SectionCreate, user_id: int = Depends(require_auth)):
    with get_db() as db:
        # Verify project exists and belongs to user
        proj = db.execute("SELECT id FROM projects WHERE id = ? AND user_id = ?", (project_id, user_id)).fetchone()
        if not proj:
            raise HTTPException(404, "Project not found")
        c = db.execute(
            "INSERT INTO sections (project_id, name, sort_order, created_at, user_id) VALUES (?,?,?,?,?)",
            (project_id, data.name, data.sort_order, now_iso(), user_id)
        )
        db.commit()
        row = db.execute("SELECT * FROM sections WHERE id = ?", (c.lastrowid,)).fetchone()
        return dict(row)

@app.patch("/api/sections/{section_id}")
def update_section(section_id: int, data: SectionUpdate, user_id: int = Depends(require_auth)):
    with get_db() as db:
        existing = db.execute("""
            SELECT s.* FROM sections s
            JOIN projects p ON s.project_id = p.id
            WHERE s.id = ? AND p.user_id = ?
        """, (section_id, user_id)).fetchone()
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
def delete_section(section_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        existing = db.execute("""
            SELECT s.* FROM sections s
            JOIN projects p ON s.project_id = p.id
            WHERE s.id = ? AND p.user_id = ?
        """, (section_id, user_id)).fetchone()
        if not existing:
            raise HTTPException(404, "Section not found")
        # Move todos to unsorted (section_id = NULL)
        db.execute("UPDATE todos SET section_id = NULL WHERE section_id = ? AND user_id = ?", (section_id, user_id))
        db.execute("DELETE FROM sections WHERE id = ?", (section_id,))
        db.commit()
        return {"deleted": section_id}

# ─── Reminders ───────────────────────────────────────────────────────────────

@app.get("/api/reminders")
def list_reminders(due_only: bool = False, user_id: int = Depends(require_auth)):
    with get_db() as db:
        sql = """
            SELECT r.*, t.title, t.status FROM reminders r
            JOIN todos t ON r.todo_id = t.id
            WHERE t.user_id = ? AND t.status IN ('pending','in_progress')
        """
        params = [user_id]
        if due_only:
            sql += " AND r.remind_at <= datetime('now') AND r.sent_at IS NULL"
        sql += " ORDER BY r.remind_at"
        rows = db.execute(sql, params).fetchall()
        return {"reminders": [dict(r) for r in rows]}

@app.post("/api/reminders/{reminder_id}/sent")
def mark_reminder_sent(reminder_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        # Verify reminder belongs to user's todo
        reminder = db.execute("""
            SELECT r.* FROM reminders r
            JOIN todos t ON r.todo_id = t.id
            WHERE r.id = ? AND t.user_id = ?
        """, (reminder_id, user_id)).fetchone()
        if not reminder:
            raise HTTPException(404, "Reminder not found")
        db.execute("UPDATE reminders SET sent_at = ? WHERE id = ?", (now_iso(), reminder_id))
        db.commit()
        return {"sent": reminder_id}

# ─── Dashboard / Stats ───────────────────────────────────────────────────────

@app.get("/api/dashboard")
def dashboard(user_id: int = Depends(require_auth)):
    with get_db() as db:
        total = db.execute("SELECT COUNT(*) FROM todos WHERE user_id = ? AND status != 'archived'", (user_id,)).fetchone()[0]
        pending = db.execute("SELECT COUNT(*) FROM todos WHERE user_id = ? AND status = 'pending'", (user_id,)).fetchone()[0]
        inprog = db.execute("SELECT COUNT(*) FROM todos WHERE user_id = ? AND status = 'in_progress'", (user_id,)).fetchone()[0]
        done = db.execute("SELECT COUNT(*) FROM todos WHERE user_id = ? AND status = 'done'", (user_id,)).fetchone()[0]
        overdue = db.execute(
            "SELECT COUNT(*) FROM todos WHERE user_id = ? AND status IN ('pending','in_progress') AND due_date < date('now')", (user_id,)
        ).fetchone()[0]
        due_today = db.execute(
            "SELECT COUNT(*) FROM todos WHERE user_id = ? AND status IN ('pending','in_progress') AND date(due_date) = date('now')", (user_id,)
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

    @app.get("/setup")
    def setup_page():
        return FileResponse(str(WEB_DIR / "setup.html"))

    @app.get("/admin")
    def admin_page():
        return FileResponse(str(WEB_DIR / "admin.html"))

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
