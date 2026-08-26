"""nia-todo: Setup endpoints (no auth required)"""

from typing import Optional
from fastapi import APIRouter, Request, Header, HTTPException, Depends
from pydantic import BaseModel, Field
import bcrypt

from db import get_db, now_iso
from services.auth import create_admin_jwt_token
from services.utils import normalize_email, sanitize_text, validate_email, validate_password, validate_admin_password
from services.audit import log_audit
from services.setup_token import consume_setup_token, validate_setup_token
from rate_limit import require_login_rate_limit, get_client_ip
from middleware.security import generate_csrf_token, set_csrf_cookie
from errors import validation_api_error

router = APIRouter()


def require_setup_token(x_setup_token: Optional[str] = Header(None, alias="X-Setup-Token")) -> None:
    if not validate_setup_token(x_setup_token):
        raise HTTPException(403, "A valid first-run setup token is required")


class AdminSetupRequest(BaseModel):
    admin_password: str

class FirstUserRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")
    email: str
    password: str
    display_name: str


@router.get("/api/setup/status")
def setup_status():
    with get_db() as db:
        config = db.execute("SELECT setup_complete, admin_token_hash FROM admin_config WHERE id = 1").fetchone()
        user_count = db.execute("SELECT COUNT(*) as c FROM users").fetchone()['c']
        return {
            "setup_complete": bool(config['setup_complete']) if config else False,
            "has_users": user_count > 0,
            "setup_token_required": not (bool(config['setup_complete']) if config else False),
            "admin_password_set": bool(config['admin_token_hash']) if config else False,
        }

@router.post("/api/setup/admin")
def setup_admin(data: AdminSetupRequest, request: Request, _: None = Depends(require_login_rate_limit), __: None = Depends(require_setup_token)):
    error = validate_admin_password(data.admin_password)
    if error:
        raise validation_api_error(error)
    with get_db() as db:
        config = db.execute("SELECT setup_complete, admin_token_hash FROM admin_config WHERE id = 1").fetchone()
        if config and config['setup_complete']:
            raise HTTPException(400, "Setup already complete")
        if config and config['admin_token_hash']:
            raise HTTPException(400, "Admin password already set")
        admin_hash = bcrypt.hashpw(data.admin_password.encode(), bcrypt.gensalt()).decode()
        db.execute(
            """INSERT INTO admin_config (id, setup_complete, admin_token_hash, created_at)
               VALUES (1, 0, ?, datetime('now'))
               ON CONFLICT(id) DO UPDATE SET
               admin_token_hash = excluded.admin_token_hash""",
            (admin_hash,)
        )
        db.commit()
        return {"message": "Admin password set"}

@router.post("/api/setup/first-user")
def setup_first_user(data: FirstUserRequest, request: Request, _: None = Depends(require_login_rate_limit), __: None = Depends(require_setup_token)):
    data.username = sanitize_text(data.username)
    data.email = normalize_email(sanitize_text(data.email))
    data.display_name = sanitize_text(data.display_name)
    email_error = validate_email(data.email)
    if email_error:
        raise validation_api_error(email_error)
    error = validate_password(data.password)
    if error:
        raise validation_api_error(error)
    with get_db() as db:
        config = db.execute("SELECT setup_complete, admin_token_hash FROM admin_config WHERE id = 1").fetchone()
        if not config or not config["admin_token_hash"] or config["setup_complete"]:
            raise HTTPException(409, "Admin password must be set before creating the first user")
        user_count = db.execute("SELECT COUNT(*) as c FROM users").fetchone()['c']
        if user_count > 0:
            raise HTTPException(400, "Users already exist")
        password_hash = bcrypt.hashpw(data.password.encode(), bcrypt.gensalt()).decode()
        c = db.execute(
            """INSERT INTO users (username, display_name, email, password_hash, is_admin, email_verified_at, email_trust_source)
               VALUES (?, ?, ?, ?, 1, datetime('now'), 'setup_first_user')""",
            (data.username, data.display_name, data.email, password_hash)
        )
        user_id = c.lastrowid
        workspace = db.execute(
            "INSERT INTO workspaces (name, color, icon, sort_order, user_id, is_default, updated_at) VALUES (?, ?, ?, 0, ?, 1, datetime('now'))",
            ('Personal', '#10b981', 'home', user_id)
        )
        workspace_id = workspace.lastrowid
        db.execute("UPDATE projects SET user_id = ?, workspace_id = ?, is_inbox = CASE WHEN id = 1 THEN 1 ELSE COALESCE(is_inbox, 0) END WHERE user_id IS NULL", (user_id, workspace_id))
        db.execute("UPDATE todos SET user_id = ? WHERE user_id IS NULL", (user_id,))
        db.execute("UPDATE sections SET user_id = ? WHERE user_id IS NULL", (user_id,))
        completed = db.execute(
            "UPDATE admin_config SET setup_complete = 1 WHERE id = 1 AND admin_token_hash IS NOT NULL AND setup_complete = 0"
        )
        if completed.rowcount != 1:
            raise HTTPException(409, "Setup state changed before completion")
        db.commit()
        consume_setup_token()
        return {
            "message": "First user created",
            "user": {"id": user_id, "username": data.username, "email": data.email, "display_name": data.display_name}
        }
