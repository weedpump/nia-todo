"""nia-todo: Auth endpoints (login, logout, me, API keys)"""

from typing import Optional
import time
from fastapi import APIRouter, Request, Response, Header, HTTPException, Depends
from pydantic import BaseModel, Field

from db import get_db, now_iso
from services.auth import (
    USER_JWT_EXPIRY_DAYS, create_jwt_token, decode_jwt_token, get_current_user, revoke_user_session,
    should_refresh_user_jwt, verify_user_credentials, sessions
)
from middleware.security import generate_csrf_token, set_csrf_cookie
from rate_limit import require_login_rate_limit, get_client_ip
from services.audit import log_audit
from services.client_info import session_user_agent
from services.two_factor import consume_mfa_action_grant, create_challenge, get_valid_trusted_device_id, mfa_required_for_user, user_mfa_state
from services.attachments import attachment_usage_payload
from errors import api_error

router = APIRouter(prefix="/api")

# ─── Pydantic Models ─────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=254)
    password: str = Field(..., min_length=1)

class CreateApiKeyRequest(BaseModel):
    name: Optional[str] = "API Key"


# ─── Helpers ───────────────────────────────────────────────────────────────────

def require_auth(request: Request, authorization: Optional[str] = Header(None), x_session_token: Optional[str] = Header(None)) -> int:
    token = None
    if authorization and authorization.startswith("Bearer "):
        bearer = authorization[7:]
        if not bearer.startswith("nt_"):
            token = bearer
    elif authorization and authorization.startswith("ApiKey "):
        token = authorization[7:]
    elif x_session_token:
        token = x_session_token
    
    user_id = get_current_user(token, client_ip=get_client_ip(request))
    if not user_id:
        raise api_error(401, "auth.notAuthenticated", "Not authenticated")
    return user_id


def require_recent_mfa_for_account_security(request: Request, authorization: Optional[str] = Header(None)) -> int:
    if not authorization or not authorization.startswith("Bearer "):
        raise api_error(401, "auth.interactiveJwtRequired", "Interactive JWT required")
    token = authorization[7:]
    with get_db() as db:
        payload = decode_jwt_token(token, db, client_ip=get_client_ip(request))
        if not payload or payload.get('mfa_enroll_only'):
            raise api_error(401, "auth.notAuthenticated", "Not authenticated")
        user_id = payload.get('user_id')
        if mfa_required_for_user(db, user_id):
            if not consume_mfa_action_grant(db, user_id, payload.get('mfa_grant')):
                raise api_error(403, "mfa.reauthRequired", "2FA re-authentication required")
            db.commit()
        return user_id


# ─── Auth Endpoints ──────────────────────────────────────────────────────────

@router.post("/login")
def login(data: LoginRequest, request: Request, response: Response, _: None = Depends(require_login_rate_limit)):
    ip = get_client_ip(request)
    with get_db() as db:
        user = verify_user_credentials(db, data.username, data.password)
        if not user:
            log_audit(db, "login_failed", ip_address=ip, details=f"username={data.username}")
            raise api_error(401, "auth.invalidCredentials", "Invalid credentials")
        mfa_required = mfa_required_for_user(db, user['id'])
        valid_trusted_device = get_valid_trusted_device_id(db, user['id'], request.cookies.get('nia_2fa_device')) if mfa_required else None
        remembered = bool(valid_trusted_device)
        if mfa_required and not remembered:
            state = user_mfa_state(db, user['id'])
            challenge = create_challenge(db, user['id'], ip_address=ip, user_agent=session_user_agent(request))
            if challenge['methods']:
                db.commit()
                return {"mfa_required": True, "challenge": challenge, "state": state}
            # Enforced MFA but no available second factor/email yet: issue an enrollment-only token.
            token = create_jwt_token(user, db, mfa_enroll_only=True, create_session=True, user_agent=session_user_agent(request), ip_address=ip)
            csrf_token = generate_csrf_token()
            set_csrf_cookie(response, csrf_token)
            log_audit(db, "login_mfa_enrollment_required", user_id=user['id'], ip_address=ip)
            db.commit()
            return {
                "access_token": token,
                "token_type": "bearer",
                "csrf_token": csrf_token,
                "mfa_enrollment_required": True,
                "user": {
                    "id": user['id'],
                    "username": user['username'],
                    "display_name": user['display_name'],
                    "email": user.get('email'),
                    "email_verified_at": user.get('email_verified_at'),
                    "email_trust_source": user.get('email_trust_source'),
                    "avatar_url": user.get('avatar_url'),
                    "braindump_enabled": bool(user.get('braindump_enabled', False)),
                    "braindump_learning_enabled": bool(user.get('braindump_learning_enabled', True)),
                    "is_admin": bool(user.get('is_admin', False))
                },
                "state": state,
            }
        trusted_device_id = valid_trusted_device[0] if valid_trusted_device else None
        token = create_jwt_token(user, db, mfa_verified=bool(mfa_required and not remembered), mfa_login_verified=bool(mfa_required and remembered), create_session=True, trusted_device_id=trusted_device_id, user_agent=session_user_agent(request), ip_address=ip)
        csrf_token = generate_csrf_token()
        set_csrf_cookie(response, csrf_token)
        log_audit(db, "login_success", user_id=user['id'], ip_address=ip, details=f"mfa={'required' if mfa_required else 'not_required'}; remembered_device={remembered}")
        from rate_limit import rate_limiter
        rate_limiter.record_successful_login(ip)
        return {
            "access_token": token,
            "token_type": "bearer",
            "user": {
                "id": user['id'],
                "username": user['username'],
                "display_name": user['display_name'],
                "email": user.get('email'),
                "email_verified_at": user.get('email_verified_at'),
                "email_trust_source": user.get('email_trust_source'),
                "avatar_url": user.get('avatar_url'),
                "braindump_enabled": bool(user.get('braindump_enabled', False)),
                "braindump_learning_enabled": bool(user.get('braindump_learning_enabled', True)),
                "is_admin": bool(user.get('is_admin', False))
            },
            "csrf_token": csrf_token,
            "mfa_enrollment_required": bool(mfa_required and not (state.get('has_totp') or state.get('has_passkey') or state.get('has_recovery_codes') or state.get('has_email_fallback'))) if mfa_required and not remembered else False
        }

@router.post("/logout")
def logout(authorization: Optional[str] = Header(None), x_session_token: Optional[str] = Header(None), request: Request = None):
    token = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
    elif x_session_token:
        token = x_session_token
    
    with get_db() as db:
        payload = decode_jwt_token(token, db, client_ip=get_client_ip(request) if request else None)
        if payload:
            user_id = payload.get('user_id')
            session_id = payload.get('sid')
            if session_id:
                revoke_user_session(db, user_id, session_id)
            else:
                db.execute("UPDATE users SET token_version = token_version + 1 WHERE id = ?", (user_id,))
            ip = get_client_ip(request) if request else None
            log_audit(db, "logout", user_id=user_id, ip_address=ip, details=f"session_id={session_id or 'legacy_all'}")
            db.commit()
        if x_session_token and x_session_token in sessions:
            del sessions[x_session_token]
    return {"logged_out": True}

@router.get("/me")
def me(request: Request, response: Response, authorization: Optional[str] = Header(None), x_session_token: Optional[str] = Header(None)):
    token = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
    elif x_session_token:
        token = x_session_token
    
    with get_db() as db:
        payload = decode_jwt_token(token, db, client_ip=get_client_ip(request))
        if not payload:
            user_id = sessions.get(token) if token else None
            if not user_id:
                raise api_error(401, "auth.notAuthenticated", "Not authenticated")
        else:
            user_id = payload.get('user_id')
        
        user = db.execute(
            "SELECT id, username, display_name, email, email_verified_at, email_trust_source, pending_email, avatar_url, avatar_updated_at, is_admin, token_version, language, COALESCE(braindump_enabled, 0) AS braindump_enabled, COALESCE(braindump_learning_enabled, 1) AS braindump_learning_enabled, default_reminder_offset_minutes FROM users WHERE id = ?",
            (user_id,)
        ).fetchone()
        if not user:
            raise HTTPException(404, "User not found")

        mfa_state = user_mfa_state(db, user_id)
        enroll_only = bool(payload and payload.get('mfa_enroll_only'))
        if payload and mfa_required_for_user(db, user_id) and not enroll_only and not (payload.get('mfa_at') or payload.get('mfa_login_at')):
            raise HTTPException(401, "MFA verification required")
        attachment_usage = attachment_usage_payload(db, user_id)
        result = {
            "id": user['id'],
            "username": user['username'],
            "display_name": user['display_name'],
            "email": user['email'],
            "email_verified_at": user['email_verified_at'],
            "email_trust_source": user['email_trust_source'],
            "pending_email": user['pending_email'],
            "avatar_url": user['avatar_url'],
            "avatar_updated_at": user['avatar_updated_at'],
            "language": user['language'] or 'auto',
            "braindump_enabled": bool(user['braindump_enabled']),
            "braindump_learning_enabled": bool(user['braindump_learning_enabled']),
            "default_reminder_offset_minutes": user['default_reminder_offset_minutes'],
            "attachments_enabled": bool(attachment_usage["enabled"]),
            "attachment_usage_bytes": attachment_usage["used_bytes"],
            "attachment_quota_bytes": attachment_usage["quota_bytes"],
            "attachment_remaining_bytes": attachment_usage["remaining_bytes"],
            "attachments_allowed_types": attachment_usage["allowed_types"],
            "attachment_max_upload_bytes": attachment_usage["max_upload_bytes"],
            "is_admin": bool(user['is_admin']),
            "two_factor": mfa_state,
            "mfa_enrollment_required": enroll_only,
        }

        # Tokens issued before per-device sessions do not contain a sid and
        # cannot be listed/revoked individually. Opportunistically migrate the
        # current token on /me so existing browser sessions become trackable
        # without requiring an explicit logout/login.
        needs_session_migration = bool(payload and not payload.get("sid"))
        if payload and (should_refresh_user_jwt(payload) or needs_session_migration):
            csrf_token = generate_csrf_token()
            set_csrf_cookie(response, csrf_token)
            token_user = dict(user)
            if payload.get('mfa_at'):
                token_user['mfa_at'] = payload.get('mfa_at')
            if payload.get('mfa_login_at'):
                token_user['mfa_login_at'] = payload.get('mfa_login_at')
            token_user["session_id"] = payload.get("sid")
            trusted_device = get_valid_trusted_device_id(db, user_id, request.cookies.get('nia_2fa_device'))
            trusted_device_id = trusted_device[0] if trusted_device else None
            new_exp = int(time.time()) + USER_JWT_EXPIRY_DAYS * 86400
            result["access_token"] = create_jwt_token(
                token_user,
                db,
                mfa_enroll_only=bool(payload.get('mfa_enroll_only')),
                create_session=needs_session_migration,
                trusted_device_id=trusted_device_id,
                user_agent=session_user_agent(request),
                ip_address=get_client_ip(request),
            )
            if payload.get("sid"):
                db.execute(
                    "UPDATE user_sessions SET expires_at = ?, last_used_at = datetime('now'), ip_address = ? WHERE id = ? AND user_id = ?",
                    (new_exp, get_client_ip(request), payload["sid"], user_id),
                )
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
def create_api_key(data: CreateApiKeyRequest, user_id: int = Depends(require_recent_mfa_for_account_security)):
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
def revoke_api_key(key_id: int, user_id: int = Depends(require_recent_mfa_for_account_security)):
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
