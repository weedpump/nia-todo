"""nia-todo: Authentication and session services"""

import secrets
import sqlite3
import time
import uuid
import bcrypt
import jwt as pyjwt
from typing import Optional
from datetime import datetime, timezone, timedelta

from db import get_db

JWT_ALGORITHM = "HS256"
USER_JWT_EXPIRY_DAYS = 30
USER_JWT_REFRESH_THRESHOLD_DAYS = 7
ADMIN_JWT_EXPIRY_DAYS = 1
sessions = {}  # Legacy in-memory session store


def get_jwt_secret(db) -> str:
    """Get or create JWT secret from admin_config."""
    try:
        row = db.execute("SELECT jwt_secret FROM admin_config WHERE id = 1").fetchone()
        if row and row['jwt_secret']:
            return row['jwt_secret']
    except sqlite3.OperationalError:
        db.execute("ALTER TABLE admin_config ADD COLUMN jwt_secret TEXT")
        db.commit()
    secret = secrets.token_urlsafe(32)
    db.execute(
        """INSERT INTO admin_config (id, jwt_secret, created_at)
           VALUES (1, ?, datetime('now'))
           ON CONFLICT(id) DO UPDATE SET jwt_secret = excluded.jwt_secret""",
        (secret,)
    )
    db.commit()
    return secret


def create_user_session(db, user_id: int, *, trusted_device_id: int = None, user_agent: str = "", ip_address: str = "", expires_at: int = None) -> str:
    session_id = uuid.uuid4().hex
    expiry = expires_at or (int(time.time()) + USER_JWT_EXPIRY_DAYS * 86400)
    db.execute(
        """INSERT INTO user_sessions (id, user_id, trusted_device_id, user_agent, ip_address, expires_at, created_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))""",
        (session_id, user_id, trusted_device_id, (user_agent or "")[:255], (ip_address or "")[:80], expiry),
    )
    return session_id


def revoke_user_session(db, user_id: int, session_id: str) -> int:
    cur = db.execute(
        "UPDATE user_sessions SET revoked_at = datetime('now') WHERE user_id = ? AND id = ? AND revoked_at IS NULL",
        (user_id, session_id),
    )
    return cur.rowcount


def revoke_user_sessions_for_trusted_device(db, user_id: int, trusted_device_id: int) -> int:
    cur = db.execute(
        "UPDATE user_sessions SET revoked_at = datetime('now') WHERE user_id = ? AND trusted_device_id = ? AND revoked_at IS NULL",
        (user_id, trusted_device_id),
    )
    return cur.rowcount


def revoke_all_user_sessions(db, user_id: int) -> int:
    cur = db.execute(
        "UPDATE user_sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL",
        (user_id,),
    )
    return cur.rowcount


def create_jwt_token(user: dict, db, mfa_verified: bool = False, mfa_enroll_only: bool = False, mfa_login_verified: bool = False, mfa_grant: str = None, create_session: bool = False, trusted_device_id: int = None, user_agent: str = "", ip_address: str = "") -> str:
    """Create a JWT token with user info, token_version and MFA assurance.

    mfa_login_at means MFA was satisfied for app access only (login challenge or
    trusted device). Sensitive-action gates require an mfa_grant, which is
    created by an explicit reauth ceremony and consumed exactly once.
    """
    secret = get_jwt_secret(db)
    now = int(time.time())
    exp = now + (USER_JWT_EXPIRY_DAYS * 86400)
    session_id = user.get('session_id') or user.get('sid')
    if create_session and not session_id:
        session_id = create_user_session(
            db,
            user['id'],
            trusted_device_id=trusted_device_id,
            user_agent=user_agent,
            ip_address=ip_address,
            expires_at=exp,
        )
    payload = {
        "user_id": user['id'],
        "username": user['username'],
        "token_version": user.get('token_version', 1),
        "is_admin": bool(user.get('is_admin', False)),
        "mfa_at": now if mfa_verified else user.get('mfa_at'),
        "mfa_login_at": now if mfa_login_verified else user.get('mfa_login_at'),
        "mfa_grant": mfa_grant or user.get('mfa_grant'),
        "mfa_enroll_only": bool(mfa_enroll_only),
        "sid": session_id,
        "iat": now,
        "exp": exp
    }
    return pyjwt.encode(payload, secret, algorithm=JWT_ALGORITHM)


def decode_jwt_token(token: str, db, client_ip: Optional[str] = None) -> Optional[dict]:
    """Decode and validate a JWT token."""
    if not token:
        return None
    try:
        secret = get_jwt_secret(db)
        payload = pyjwt.decode(token, secret, algorithms=[JWT_ALGORITHM])
        user_id = payload.get('user_id')
        db_version = db.execute(
            "SELECT token_version FROM users WHERE id = ?",
            (user_id,)
        ).fetchone()
        if not db_version:
            return None
        if db_version['token_version'] != payload.get('token_version'):
            return None
        session_id = payload.get('sid')
        if session_id:
            now = int(time.time())
            session = db.execute(
                """SELECT id, last_used_at, ip_address
                   FROM user_sessions
                   WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at >= ?""",
                (session_id, user_id, now),
            ).fetchone()
            if not session:
                return None
            last_used_ts = None
            if session["last_used_at"]:
                last_used_row = db.execute("SELECT strftime('%s', ?) AS ts", (session["last_used_at"],)).fetchone()
                last_used_ts = int(last_used_row["ts"] or 0) if last_used_row else None
            current_ip = (client_ip or "")[:80]
            ip_changed = bool(current_ip and current_ip != (session["ip_address"] or ""))
            should_touch = not last_used_ts or last_used_ts <= now - 300 or ip_changed
            if should_touch:
                if current_ip:
                    db.execute(
                        "UPDATE user_sessions SET last_used_at = datetime('now'), ip_address = ? WHERE id = ? AND user_id = ?",
                        (current_ip, session_id, user_id),
                    )
                else:
                    db.execute("UPDATE user_sessions SET last_used_at = datetime('now') WHERE id = ? AND user_id = ?", (session_id, user_id))
        return payload
    except (pyjwt.ExpiredSignatureError, pyjwt.InvalidTokenError):
        return None


def should_refresh_user_jwt(payload: dict) -> bool:
    """Return True when a valid user token is close enough to expiry to rotate."""
    exp = payload.get('exp')
    if not exp:
        return False
    remaining_seconds = int(exp) - int(time.time())
    return remaining_seconds <= USER_JWT_REFRESH_THRESHOLD_DAYS * 86400


def get_current_user(token: Optional[str] = None, client_ip: Optional[str] = None) -> Optional[int]:
    """Extract user_id from JWT token, API key, or legacy session fallback."""
    if not token:
        return None
    # Legacy session fallback
    legacy_user = sessions.get(token)
    if legacy_user:
        return legacy_user
    # JWT
    with get_db() as db:
        payload = decode_jwt_token(token, db, client_ip=client_ip)
        if payload:
            if payload.get('mfa_enroll_only'):
                return None
            user_id = payload.get('user_id')
            from services.two_factor import mfa_required_for_user
            if mfa_required_for_user(db, user_id) and not (payload.get('mfa_at') or payload.get('mfa_login_at')):
                return None
            return user_id
        # API key
        if token.startswith("nt_"):
            prefix = token[3:11]
            cur = db.execute(
                "SELECT id, key_hash, user_id FROM api_keys WHERE key_prefix = ? AND revoked_at IS NULL",
                (prefix,)
            ).fetchall()
            for row in cur:
                if bcrypt.checkpw(token.encode(), row['key_hash'].encode()):
                    db.execute(
                        "UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?",
                        (row['id'],)
                    )
                    db.commit()
                    return row['user_id']
    return None


def get_current_user_allow_mfa_enrollment(token: Optional[str] = None) -> Optional[int]:
    """Extract user_id from a JWT, including MFA-enrollment-only tokens."""
    if not token:
        return None
    with get_db() as db:
        payload = decode_jwt_token(token, db)
        if payload:
            return payload.get('user_id')
    return None


def verify_user_credentials(db, username: str, password: str) -> Optional[dict]:
    identifier = (username or "").strip()
    row = db.execute(
        """SELECT id, username, display_name, email, email_verified_at, email_trust_source, avatar_url, password_hash, is_admin, token_version,
                  COALESCE(braindump_enabled, 0) AS braindump_enabled, COALESCE(braindump_learning_enabled, 1) AS braindump_learning_enabled
           FROM users
           WHERE username = ?
              OR (lower(email) = lower(?) AND email_verified_at IS NOT NULL)
           ORDER BY CASE WHEN username = ? THEN 0 ELSE 1 END
           LIMIT 1""",
        (identifier, identifier, identifier)
    ).fetchone()
    if not row:
        return None
    if bcrypt.checkpw(password.encode(), row['password_hash'].encode()):
        return dict(row)
    return None


def create_admin_jwt_token(db) -> str:
    """Create a JWT token for admin with admin_token_version."""
    secret = get_jwt_secret(db)
    now = int(time.time())
    config = db.execute("SELECT admin_token_version FROM admin_config WHERE id = 1").fetchone()
    admin_version = config["admin_token_version"] if config else 1
    payload = {
        "sub": "admin",
        "role": "admin",
        "admin_version": admin_version,
        "iat": now,
        "exp": now + (ADMIN_JWT_EXPIRY_DAYS * 86400)
    }
    return pyjwt.encode(payload, secret, algorithm=JWT_ALGORITHM)


def verify_admin_token(authorization: Optional[str]) -> bool:
    """Verify admin JWT token and check admin_token_version."""
    if not authorization or not authorization.startswith("Bearer "):
        return False
    token = authorization[7:]
    try:
        with get_db() as db:
            secret = get_jwt_secret(db)
        payload = pyjwt.decode(token, secret, algorithms=[JWT_ALGORITHM])
        if payload.get("role") != "admin" or payload.get("sub") != "admin":
            return False
        with get_db() as db:
            config = db.execute("SELECT admin_token_version FROM admin_config WHERE id = 1").fetchone()
            if not config or payload.get("admin_version") != config["admin_token_version"]:
                return False
        return True
    except (pyjwt.ExpiredSignatureError, pyjwt.InvalidTokenError):
        return False
