"""nia-todo: Admin endpoints (users, setup, password management)"""

from typing import Optional
from fastapi import APIRouter, Request, Response, HTTPException, Depends
from pydantic import BaseModel
import bcrypt

from db import get_db, now_iso
from services.auth import create_admin_jwt_token, verify_admin_token
from services.utils import sanitize_text, validate_password, validate_admin_password
from services.audit import log_audit
from rate_limit import require_login_rate_limit, get_client_ip
from middleware.security import generate_csrf_token, set_csrf_cookie

router = APIRouter(prefix="/api/admin")


# ─── Pydantic Models ─────────────────────────────────────────────────────────

class CreateUserRequest(BaseModel):
    username: str
    password: str
    display_name: str

class ChangeAdminPasswordRequest(BaseModel):
    old_password: str
    new_password: str

class ResetUserPasswordRequest(BaseModel):
    new_password: str

class AdminLoginRequest(BaseModel):
    password: str


# ─── Helpers ─────────────────────────────────────────────────────────────────

from typing import Optional
from fastapi import Header

def require_admin(authorization: Optional[str] = Header(None)):
    if not verify_admin_token(authorization):
        raise HTTPException(status_code=403, detail="Admin-Authentifizierung erforderlich")
    return True


# ─── Admin Auth ──────────────────────────────────────────────────────────────

@router.post("/login")
def admin_login(data: AdminLoginRequest, request: Request, response: Response, _: None = Depends(require_login_rate_limit)):
    ip = get_client_ip(request)
    with get_db() as db:
        config = db.execute("SELECT admin_token_hash, setup_complete FROM admin_config WHERE id = 1").fetchone()
        if not config or not config["admin_token_hash"] or not config["setup_complete"]:
            raise HTTPException(400, "Setup erforderlich")
        if not bcrypt.checkpw(data.password.encode(), config["admin_token_hash"].encode()):
            raise HTTPException(401, "Falsches Admin-Passwort")
        token = create_admin_jwt_token(db)
        csrf_token = generate_csrf_token()
        set_csrf_cookie(response, csrf_token)
        from rate_limit import rate_limiter
        rate_limiter.record_successful_login(ip)
        return {"access_token": token, "token_type": "bearer", "admin": True, "csrf_token": csrf_token}

@router.post("/logout")
def admin_logout(authorization: Optional[str] = Header(None), _: bool = Depends(require_admin)):
    with get_db() as db:
        db.execute("UPDATE admin_config SET admin_token_version = admin_token_version + 1 WHERE id = 1")
        db.commit()
    return {"message": "Admin abgemeldet. Alle Admin-Sessions ungültig."}


# ─── User Management ─────────────────────────────────────────────────────────

@router.post("/users")
def create_user(data: CreateUserRequest, _: bool = Depends(require_admin)):
    data.username = sanitize_text(data.username)
    data.display_name = sanitize_text(data.display_name)
    error = validate_password(data.password)
    if error:
        raise HTTPException(400, error)
    with get_db() as db:
        existing = db.execute("SELECT id FROM users WHERE username = ?", (data.username,)).fetchone()
        if existing:
            raise HTTPException(409, "Username already exists")
        password_hash = bcrypt.hashpw(data.password.encode(), bcrypt.gensalt()).decode()
        c = db.execute(
            "INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?, ?, ?, 0)",
            (data.username, data.display_name, password_hash)
        )
        user_id = c.lastrowid

        # Create default projects for the new user
        default_projects = [
            ('Inbox', '#64748b', 0, 1),
            ('Privat', '#10b981', 1, 0),
            ('Arbeit', '#3b82f6', 2, 0),
            ('Einkauf', '#f59e0b', 3, 0),
        ]
        for name, color, sort_order, is_inbox in default_projects:
            db.execute(
                "INSERT INTO projects (name, color, sort_order, user_id, is_inbox, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
                (name, color, sort_order, user_id, is_inbox)
            )

        db.commit()
        log_audit(db, "user_created", user_id=user_id, details=f"username={data.username}")
        return {"id": user_id, "username": data.username, "display_name": data.display_name, "created_at": now_iso()}

@router.get("/users")
def list_users(_: bool = Depends(require_admin)):
    with get_db() as db:
        rows = db.execute("SELECT id, username, display_name, is_admin, created_at FROM users ORDER BY id").fetchall()
        return {"users": [dict(r) for r in rows]}

@router.delete("/users/{user_id}")
def delete_user(user_id: int, _: bool = Depends(require_admin)):
    with get_db() as db:
        user = db.execute("SELECT is_admin FROM users WHERE id = ?", (user_id,)).fetchone()
        if not user:
            raise HTTPException(404, "User not found")
        if user['is_admin']:
            raise HTTPException(400, "Cannot delete admin user")
        db.execute("DELETE FROM api_keys WHERE user_id = ?", (user_id,))
        db.execute("DELETE FROM reminders WHERE todo_id IN (SELECT id FROM todos WHERE user_id = ?)", (user_id,))
        db.execute("DELETE FROM sections WHERE user_id = ?", (user_id,))
        db.execute("DELETE FROM todos WHERE user_id = ?", (user_id,))
        db.execute("DELETE FROM projects WHERE user_id = ? AND COALESCE(is_inbox, 0) = 0", (user_id,))
        db.execute("DELETE FROM users WHERE id = ?", (user_id,))
        db.commit()
        return {"deleted": user_id}


# ─── Password Management ──────────────────────────────────────────────────────

@router.post("/change-password")
def change_admin_password(data: ChangeAdminPasswordRequest, _: bool = Depends(require_admin)):
    error = validate_admin_password(data.new_password)
    if error:
        raise HTTPException(400, error)
    with get_db() as db:
        config = db.execute("SELECT admin_token_hash FROM admin_config WHERE id = 1").fetchone()
        if not config or not config['admin_token_hash']:
            raise HTTPException(500, "Admin-Konfiguration nicht gefunden")
        if not bcrypt.checkpw(data.old_password.encode(), config['admin_token_hash'].encode()):
            raise HTTPException(401, "Altes Admin-Passwort ist falsch")
        new_hash = bcrypt.hashpw(data.new_password.encode(), bcrypt.gensalt()).decode()
        db.execute(
            "UPDATE admin_config SET admin_token_hash = ?, admin_token_version = admin_token_version + 1 WHERE id = 1",
            (new_hash,)
        )
        db.commit()
    return {"message": "Admin-Passwort geändert. Bitte melde dich erneut an."}

@router.post("/users/{user_id}/change-password")
def admin_change_user_password(user_id: int, data: ResetUserPasswordRequest, _: bool = Depends(require_admin)):
    error = validate_password(data.new_password)
    if error:
        raise HTTPException(400, error)
    with get_db() as db:
        user = db.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
        if not user:
            raise HTTPException(404, "User not found")
        new_hash = bcrypt.hashpw(data.new_password.encode(), bcrypt.gensalt()).decode()
        db.execute(
            "UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?",
            (new_hash, user_id)
        )
        db.commit()
    return {"message": "Passwort geändert. Der Benutzer muss sich erneut anmelden."}
