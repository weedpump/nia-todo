"""nia-todo: Auth endpoints (login, logout, me, API keys)"""

from typing import Optional
from fastapi import APIRouter, Request, Response, Header, HTTPException, Depends
from pydantic import BaseModel, Field

from db import get_db, now_iso
from services.auth import (
    create_jwt_token, decode_jwt_token, get_current_user,
    should_refresh_user_jwt, verify_user_credentials, sessions
)
from middleware.security import generate_csrf_token, set_csrf_cookie
from rate_limit import require_login_rate_limit, get_client_ip
from services.audit import log_audit

router = APIRouter(prefix="/api")

# ─── Pydantic Models ─────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=32, pattern=r'^[a-zA-Z0-9_\-]+$')
    password: str = Field(..., min_length=1)

class CreateApiKeyRequest(BaseModel):
    name: Optional[str] = "API Key"


# ─── Helpers ───────────────────────────────────────────────────────────────────

def require_auth(authorization: Optional[str] = Header(None), x_session_token: Optional[str] = Header(None)) -> int:
    token = None
    if authorization and authorization.startswith("Bearer "):
        bearer = authorization[7:]
        if not bearer.startswith("nt_"):
            token = bearer
    elif authorization and authorization.startswith("ApiKey "):
        token = authorization[7:]
    elif x_session_token:
        token = x_session_token
    
    user_id = get_current_user(token)
    if not user_id:
        raise HTTPException(401, "Not authenticated")
    return user_id


# ─── Auth Endpoints ──────────────────────────────────────────────────────────

@router.post("/login")
def login(data: LoginRequest, request: Request, response: Response, _: None = Depends(require_login_rate_limit)):
    ip = get_client_ip(request)
    with get_db() as db:
        user = verify_user_credentials(db, data.username, data.password)
        if not user:
            log_audit(db, "login_failed", ip_address=ip, details=f"username={data.username}")
            raise HTTPException(401, "Invalid credentials")
        token = create_jwt_token(user, db)
        csrf_token = generate_csrf_token()
        set_csrf_cookie(response, csrf_token)
        log_audit(db, "login_success", user_id=user['id'], ip_address=ip)
        from rate_limit import rate_limiter
        rate_limiter.record_successful_login(ip)
        return {
            "access_token": token,
            "token_type": "bearer",
            "user": {
                "id": user['id'],
                "username": user['username'],
                "display_name": user['display_name'],
                "is_admin": bool(user.get('is_admin', False))
            },
            "csrf_token": csrf_token
        }

@router.post("/logout")
def logout(authorization: Optional[str] = Header(None), x_session_token: Optional[str] = Header(None), request: Request = None):
    token = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
    elif x_session_token:
        token = x_session_token
    
    with get_db() as db:
        payload = decode_jwt_token(token, db)
        if payload:
            user_id = payload.get('user_id')
            db.execute("UPDATE users SET token_version = token_version + 1 WHERE id = ?", (user_id,))
            db.commit()
            ip = get_client_ip(request) if request else None
            log_audit(db, "logout", user_id=user_id, ip_address=ip)
        if x_session_token and x_session_token in sessions:
            del sessions[x_session_token]
    return {"logged_out": True}

@router.get("/me")
def me(response: Response, authorization: Optional[str] = Header(None), x_session_token: Optional[str] = Header(None)):
    token = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
    elif x_session_token:
        token = x_session_token
    
    with get_db() as db:
        payload = decode_jwt_token(token, db)
        if not payload:
            user_id = sessions.get(token) if token else None
            if not user_id:
                raise HTTPException(401, "Not authenticated")
        else:
            user_id = payload.get('user_id')
        
        user = db.execute(
            "SELECT id, username, display_name, is_admin, token_version FROM users WHERE id = ?",
            (user_id,)
        ).fetchone()
        if not user:
            raise HTTPException(404, "User not found")

        result = {
            "id": user['id'],
            "username": user['username'],
            "display_name": user['display_name'],
            "is_admin": bool(user['is_admin']),
        }

        if payload and should_refresh_user_jwt(payload):
            csrf_token = generate_csrf_token()
            set_csrf_cookie(response, csrf_token)
            result["access_token"] = create_jwt_token(dict(user), db)
            result["token_type"] = "bearer"
            result["csrf_token"] = csrf_token

        return result


# ─── API Key Endpoints ────────────────────────────────────────────────────────

import string
import secrets
import bcrypt

API_KEY_ALPHABET = string.ascii_letters + string.digits
API_KEY_LENGTH = 32

def generate_api_key() -> str:
    random_part = ''.join(secrets.choice(API_KEY_ALPHABET) for _ in range(API_KEY_LENGTH))
    return f"nt_{random_part}"

def hash_api_key(key: str) -> str:
    return bcrypt.hashpw(key.encode(), bcrypt.gensalt()).decode()

def get_api_key_prefix(key: str) -> str:
    return key[3:11]

@router.get("/me/api-keys")
def list_api_keys(user_id: int = Depends(require_auth)):
    with get_db() as db:
        rows = db.execute("""
            SELECT id, name, key_prefix, created_at, last_used_at, revoked_at
            FROM api_keys
            WHERE user_id = ?
            ORDER BY created_at DESC
        """, (user_id,)).fetchall()
        return {"api_keys": [dict(r) for r in rows]}

@router.post("/me/api-keys")
def create_api_key(data: CreateApiKeyRequest, user_id: int = Depends(require_auth)):
    from services.utils import sanitize_text
    name = sanitize_text(data.name) or "API Key"
    with get_db() as db:
        full_key = generate_api_key()
        key_hash = hash_api_key(full_key)
        key_prefix = get_api_key_prefix(full_key)
        c = db.execute(
            """INSERT INTO api_keys (user_id, name, key_hash, key_prefix, created_at)
               VALUES (?, ?, ?, ?, datetime('now'))""",
            (user_id, name, key_hash, key_prefix)
        )
        db.commit()
        return {
            "id": c.lastrowid,
            "name": name,
            "prefix": f"nt_{key_prefix}",
            "key": full_key,
            "created_at": now_iso()
        }

@router.delete("/me/api-keys/{key_id}")
def revoke_api_key(key_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        key = db.execute(
            "SELECT id FROM api_keys WHERE id = ? AND user_id = ?",
            (key_id, user_id)
        ).fetchone()
        if not key:
            raise HTTPException(404, "API key not found")
        db.execute("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ?", (key_id,))
        db.commit()
        return {"revoked": key_id}
