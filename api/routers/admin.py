"""nia-todo: Admin endpoints (users, setup, password management)"""

from typing import Optional
from fastapi import APIRouter, Request, Response, HTTPException, Depends
from pydantic import BaseModel
import bcrypt
import hashlib
import secrets

from db import get_db, now_iso
from services.auth import create_admin_jwt_token, verify_admin_token
from services.utils import sanitize_text, validate_email, validate_password, validate_admin_password
from services.audit import log_audit
from services.instance_config import get_instance_config, get_public_base_url, update_instance_config
from rate_limit import require_login_rate_limit, get_client_ip
from middleware.security import generate_csrf_token, set_csrf_cookie

router = APIRouter(prefix="/api/admin")


# ─── Pydantic Models ─────────────────────────────────────────────────────────

class CreateUserRequest(BaseModel):
    username: str
    display_name: str
    email: str

class UpdateUserRequest(BaseModel):
    email: str
    display_name: Optional[str] = None

class ChangeAdminPasswordRequest(BaseModel):
    old_password: str
    new_password: str

class ResetUserPasswordRequest(BaseModel):
    # Kept for backward-compatible request parsing, but admins no longer set
    # user passwords directly. The endpoint now returns a one-time setup link.
    new_password: Optional[str] = None

class AdminLoginRequest(BaseModel):
    password: str

class InstanceConfigRequest(BaseModel):
    public_base_url: str = ""
    allowed_origins: list[str] = []
    trusted_proxies: list[str] = []


# ─── Helpers ─────────────────────────────────────────────────────────────────

from typing import Optional
from fastapi import Header

def require_admin(authorization: Optional[str] = Header(None)):
    if not verify_admin_token(authorization):
        raise HTTPException(status_code=403, detail="Admin-Authentifizierung erforderlich")
    return True


PASSWORD_LINK_TTL_HOURS = 24


def _hash_setup_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _make_password_setup_link(request: Request, token: str) -> str:
    base_url = get_public_base_url(request)
    return f"{base_url}/set-password?token={token}"


def create_password_setup_token(db, user_id: int, purpose: str = "reset") -> str:
    token = secrets.token_urlsafe(32)
    db.execute(
        """INSERT INTO password_setup_tokens
           (user_id, token_hash, token_prefix, purpose, expires_at, created_by_admin)
           VALUES (?, ?, ?, ?, datetime('now', ?), 1)""",
        (user_id, _hash_setup_token(token), token[:12], purpose, f"+{PASSWORD_LINK_TTL_HOURS} hours")
    )
    return token


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


# ─── Instance Configuration ─────────────────────────────────────────────────

@router.get("/instance-config")
def admin_get_instance_config(_: bool = Depends(require_admin)):
    return get_instance_config()


@router.patch("/instance-config")
def admin_update_instance_config(data: InstanceConfigRequest, request: Request, _: bool = Depends(require_admin)):
    return update_instance_config(
        public_base_url=data.public_base_url,
        allowed_origins=data.allowed_origins,
        trusted_proxies=data.trusted_proxies,
        client_ip=get_client_ip(request),
    )


# ─── User Management ─────────────────────────────────────────────────────────

@router.post("/users")
def create_user(data: CreateUserRequest, request: Request, _: bool = Depends(require_admin)):
    data.username = sanitize_text(data.username)
    data.display_name = sanitize_text(data.display_name)
    data.email = sanitize_text(data.email)
    email_error = validate_email(data.email)
    if email_error:
        raise HTTPException(400, email_error)
    with get_db() as db:
        existing = db.execute("SELECT id FROM users WHERE username = ?", (data.username,)).fetchone()
        if existing:
            raise HTTPException(409, "Username already exists")
        if data.email:
            existing_email = db.execute("SELECT id FROM users WHERE email = ?", (data.email,)).fetchone()
            if existing_email:
                raise HTTPException(409, "Email already exists")
        unusable_password_hash = bcrypt.hashpw(secrets.token_urlsafe(32).encode(), bcrypt.gensalt()).decode()
        c = db.execute(
            "INSERT INTO users (username, display_name, email, password_hash, is_admin) VALUES (?, ?, ?, ?, 0)",
            (data.username, data.display_name, data.email, unusable_password_hash)
        )
        user_id = c.lastrowid

        # Create default workspace and projects for the new user
        workspace = db.execute(
            "INSERT INTO workspaces (name, color, icon, sort_order, user_id, is_default, updated_at) VALUES (?, ?, ?, 0, ?, 1, datetime('now'))",
            ('Privat', '#10b981', 'home', user_id)
        )
        workspace_id = workspace.lastrowid
        default_projects = [
            ('Inbox', '#64748b', 'inbox', 0, 1),
            ('Privat', '#10b981', None, 1, 0),
            ('Arbeit', '#3b82f6', None, 2, 0),
            ('Einkauf', '#f59e0b', None, 3, 0),
        ]
        for name, color, icon, sort_order, is_inbox in default_projects:
            db.execute(
                "INSERT INTO projects (name, color, icon, sort_order, user_id, is_inbox, workspace_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))",
                (name, color, icon, sort_order, user_id, is_inbox, workspace_id)
            )

        token = create_password_setup_token(db, user_id, "invite")
        db.commit()
        log_audit(db, "user_created", user_id=user_id, details=f"username={data.username}")
        return {
            "id": user_id,
            "username": data.username,
            "display_name": data.display_name,
            "email": data.email,
            "created_at": now_iso(),
            "password_setup_url": _make_password_setup_link(request, token),
            "password_setup_expires_hours": PASSWORD_LINK_TTL_HOURS,
        }

@router.get("/users")
def list_users(_: bool = Depends(require_admin)):
    with get_db() as db:
        rows = db.execute("SELECT id, username, display_name, email, is_admin, created_at FROM users ORDER BY id").fetchall()
        return {"users": [dict(r) for r in rows]}

@router.patch("/users/{user_id}")
def update_user(user_id: int, data: UpdateUserRequest, _: bool = Depends(require_admin)):
    email = sanitize_text(data.email)
    display_name = sanitize_text(data.display_name) if data.display_name is not None else None
    email_error = validate_email(email)
    if email_error:
        raise HTTPException(400, email_error)
    with get_db() as db:
        user = db.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
        if not user:
            raise HTTPException(404, "User not found")
        existing_email = db.execute("SELECT id FROM users WHERE email = ? AND id != ?", (email, user_id)).fetchone()
        if existing_email:
            raise HTTPException(409, "Email already exists")
        if display_name is None:
            db.execute("UPDATE users SET email = ? WHERE id = ?", (email, user_id))
        else:
            db.execute("UPDATE users SET email = ?, display_name = ? WHERE id = ?", (email, display_name, user_id))
        db.commit()
        return {"id": user_id, "email": email, "display_name": display_name}

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
def admin_change_user_password(user_id: int, data: ResetUserPasswordRequest, request: Request, _: bool = Depends(require_admin)):
    return admin_create_user_password_link(user_id, request)


@router.post("/users/{user_id}/password-link")
def admin_create_user_password_link(user_id: int, request: Request, _: bool = Depends(require_admin)):
    with get_db() as db:
        user = db.execute("SELECT id, username FROM users WHERE id = ?", (user_id,)).fetchone()
        if not user:
            raise HTTPException(404, "User not found")
        token = create_password_setup_token(db, user_id, "reset")
        db.commit()
        log_audit(db, "password_setup_link_created", user_id=user_id, details=f"username={user['username']}")
    return {
        "message": "Passwort-Link erstellt.",
        "password_setup_url": _make_password_setup_link(request, token),
        "password_setup_expires_hours": PASSWORD_LINK_TTL_HOURS,
    }
