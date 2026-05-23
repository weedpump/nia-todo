"""nia-todo: Public one-time password setup/reset endpoints"""

import bcrypt
import hashlib
import secrets
from fastapi import APIRouter, HTTPException, Request, Depends
from pydantic import BaseModel

from db import get_db
from rate_limit import rate_limiter, get_client_ip, require_password_reset_rate_limit
from services.email import send_email
from services.email_config import get_password_link_ttl_hours, is_email_configured
from services.email_templates import password_setup_email
from services.instance_config import get_public_base_url
from services.utils import validate_password

router = APIRouter(prefix="/api/password-setup")


class CompletePasswordSetupRequest(BaseModel):
    token: str
    password: str

class RequestPasswordResetRequest(BaseModel):
    identifier: str

class ResendPasswordSetupRequest(BaseModel):
    token: str


def _hash_setup_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _make_password_setup_link(request: Request, token: str) -> str:
    return f"{get_public_base_url(request)}/set-password?token={token}"


def _create_password_setup_token(db, user_id: int, purpose: str = "reset", requested_by: str = "user") -> str:
    token = secrets.token_urlsafe(32)
    db.execute(
        """UPDATE password_setup_tokens
           SET status = 'replaced', replaced_at = datetime('now')
           WHERE user_id = ?
             AND purpose = ?
             AND status = 'active'
             AND used_at IS NULL""",
        (user_id, purpose),
    )
    db.execute(
        """INSERT INTO password_setup_tokens
           (user_id, token_hash, token_prefix, purpose, expires_at, created_by_admin, status, requested_by)
           VALUES (?, ?, ?, ?, datetime('now', ?), 0, 'active', ?)""",
        (user_id, _hash_setup_token(token), token[:12], purpose, f"+{get_password_link_ttl_hours()} hours", requested_by)
    )
    return token


def _get_valid_token(db, token: str):
    if not token or len(token) < 24:
        return None
    return db.execute(
        """SELECT pst.*, u.username, u.display_name, u.email
           FROM password_setup_tokens pst
           JOIN users u ON u.id = pst.user_id
           WHERE pst.token_prefix = ?
             AND pst.token_hash = ?
             AND pst.used_at IS NULL
             AND pst.status = 'active'
             AND datetime(pst.expires_at) > datetime('now')
           ORDER BY pst.id DESC
           LIMIT 1""",
        (token[:12], _hash_setup_token(token))
    ).fetchone()


def _get_expired_resend_context(db, token: str):
    if not token or len(token) < 24:
        return None
    return db.execute(
        """SELECT pst.*, u.username, u.display_name, u.email
           FROM password_setup_tokens pst
           JOIN users u ON u.id = pst.user_id
           WHERE pst.token_prefix = ?
             AND pst.token_hash = ?
             AND pst.used_at IS NULL
             AND pst.status = 'active'
             AND datetime(pst.expires_at) <= datetime('now')
           ORDER BY pst.id DESC
           LIMIT 1""",
        (token[:12], _hash_setup_token(token))
    ).fetchone()


@router.get("/features")
def password_setup_features():
    email_configured = is_email_configured()
    return {
        "email_configured": email_configured,
        "password_reset_available": email_configured,
    }


@router.post("/request")
def request_password_reset(data: RequestPasswordResetRequest, request: Request, _: None = Depends(require_password_reset_rate_limit)):
    identifier = (data.identifier or "").strip()
    neutral = {"message": "Falls ein passendes Konto existiert, wurde eine E-Mail gesendet."}
    if not identifier or not is_email_configured():
        return neutral

    identifier_key = hashlib.sha256(identifier.lower().encode()).hexdigest()
    if not rate_limiter.check_password_reset(f"identifier:{identifier_key}"):
        return neutral

    with get_db() as db:
        user = db.execute(
            """SELECT id, username, display_name, email
               FROM users
               WHERE username = ?
                  OR (lower(email) = lower(?) AND email_verified_at IS NOT NULL)
               ORDER BY CASE WHEN username = ? THEN 0 ELSE 1 END
               LIMIT 1""",
            (identifier, identifier, identifier),
        ).fetchone()
        if not user or not user['email']:
            return neutral
        token = _create_password_setup_token(db, user['id'], "reset", "user")
        link = _make_password_setup_link(request, token)
        subject, text, html = password_setup_email(
            display_name=user['display_name'],
            username=user['username'],
            link=link,
            purpose="reset",
            expires_hours=get_password_link_ttl_hours(),
        )
        send_email(to=user['email'], subject=subject, text=text, html=html)
        db.commit()
    return neutral


@router.get("/validate")
def validate_password_setup_token(token: str):
    with get_db() as db:
        row = _get_valid_token(db, token)
        if row:
            return {
                "valid": True,
                "username": row['username'],
                "display_name": row['display_name'],
                "purpose": row['purpose'],
                "expires_at": row['expires_at'],
            }
        expired = _get_expired_resend_context(db, token)
        if expired:
            return {
                "valid": False,
                "expired": True,
                "can_resend": True,
                "username": expired['username'],
                "display_name": expired['display_name'],
                "purpose": expired['purpose'],
            }
        raise HTTPException(404, "Link ist ungültig oder abgelaufen")


@router.post("/resend")
def resend_password_setup_link(data: ResendPasswordSetupRequest, request: Request, _: None = Depends(require_password_reset_rate_limit)):
    with get_db() as db:
        row = _get_expired_resend_context(db, data.token)
        if not row:
            raise HTTPException(404, "Link ist ungültig oder abgelaufen")
        new_token = _create_password_setup_token(db, row['user_id'], row['purpose'], "user")
        link = _make_password_setup_link(request, new_token)
        emailed = False
        if is_email_configured() and row['email']:
            subject, text, html = password_setup_email(
                display_name=row['display_name'],
                username=row['username'],
                link=link,
                purpose=row['purpose'],
                expires_hours=get_password_link_ttl_hours(),
            )
            send_email(to=row['email'], subject=subject, text=text, html=html)
            emailed = True
        db.commit()
    response = {
        "message": "Neuer Link wurde per E-Mail gesendet." if emailed else "Neuer Link wurde erstellt.",
        "password_setup_delivery": "email" if emailed else "manual",
        "password_setup_expires_hours": get_password_link_ttl_hours(),
    }
    if not emailed:
        response["password_setup_url"] = link
    return response


@router.post("/complete")
def complete_password_setup(data: CompletePasswordSetupRequest):
    error = validate_password(data.password)
    if error:
        raise HTTPException(400, error)
    with get_db() as db:
        row = _get_valid_token(db, data.token)
        if not row:
            raise HTTPException(404, "Link ist ungültig oder abgelaufen")
        password_hash = bcrypt.hashpw(data.password.encode(), bcrypt.gensalt()).decode()
        if row['purpose'] == 'invite':
            db.execute(
                """UPDATE users
                   SET password_hash = ?,
                       token_version = token_version + 1,
                       email_verified_at = COALESCE(email_verified_at, datetime('now'))
                   WHERE id = ?""",
                (password_hash, row['user_id'])
            )
        else:
            db.execute(
                "UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?",
                (password_hash, row['user_id'])
            )
        db.execute(
            "UPDATE password_setup_tokens SET used_at = datetime('now'), status = 'used' WHERE id = ?",
            (row['id'],)
        )
        db.commit()
        return {"message": "Passwort gesetzt. Du kannst dich jetzt anmelden."}
