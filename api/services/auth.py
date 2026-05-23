"""nia-todo: Authentication and session services"""

import secrets
import sqlite3
import time
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
        "exp": now + (USER_JWT_EXPIRY_DAYS * 86400)
    }
    return pyjwt.encode(payload, secret, algorithm=JWT_ALGORITHM)


def decode_jwt_token(token: str, db) -> Optional[dict]:
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


def get_current_user(token: Optional[str] = None) -> Optional[int]:
    """Extract user_id from JWT token, API key, or legacy session fallback."""
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


def verify_user_credentials(db, username: str, password: str) -> Optional[dict]:
    identifier = (username or "").strip()
    row = db.execute(
        """SELECT id, username, display_name, email, email_verified_at, email_trust_source, avatar_url, password_hash, is_admin, token_version
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
