"""Pending email verification helpers."""

import hashlib
import secrets
from typing import Optional

from fastapi import Request

from services.email import send_email
from services.email_config import get_password_link_ttl_hours, is_email_configured
from services.email_templates import email_verification_email
from services.instance_config import get_public_base_url


def hash_email_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def make_email_verify_link(request: Request, token: str) -> str:
    return f"{get_public_base_url(request)}/?verifyEmail={token}"


def set_email_or_pending(db, *, user_id: int, email: str, request: Optional[Request], requested_by: str = "user") -> dict:
    """Set email directly without SMTP, otherwise create pending verification and send mail."""
    if not is_email_configured():
        db.execute(
            """UPDATE users
               SET email = ?,
                   email_verified_at = datetime('now'),
                   pending_email = NULL,
                   pending_email_token_hash = NULL,
                   pending_email_token_prefix = NULL,
                   pending_email_token_expires_at = NULL,
                   email_changed_at = datetime('now')
               WHERE id = ?""",
            (email, user_id),
        )
        return {"email": email, "pending_email": None, "email_verification_required": False, "email_verification_delivery": "direct"}

    user = db.execute("SELECT username, display_name FROM users WHERE id = ?", (user_id,)).fetchone()
    token = secrets.token_urlsafe(32)
    db.execute(
        """UPDATE users
           SET pending_email = ?,
               pending_email_token_hash = ?,
               pending_email_token_prefix = ?,
               pending_email_token_expires_at = datetime('now', ?),
               email_changed_at = datetime('now')
           WHERE id = ?""",
        (email, hash_email_token(token), token[:12], f"+{get_password_link_ttl_hours()} hours", user_id),
    )
    link = make_email_verify_link(request, token) if request else ""
    subject, text, html = email_verification_email(
        display_name=user['display_name'] if user else "",
        username=user['username'] if user else "",
        link=link,
        expires_hours=get_password_link_ttl_hours(),
    )
    send_email(to=email, subject=subject, text=text, html=html)
    return {"email": None, "pending_email": email, "email_verification_required": True, "email_verification_delivery": "email"}


def verify_pending_email(db, token: str) -> bool:
    if not token or len(token) < 24:
        return False
    row = db.execute(
        """SELECT id, pending_email
           FROM users
           WHERE pending_email_token_prefix = ?
             AND pending_email_token_hash = ?
             AND pending_email IS NOT NULL
             AND datetime(pending_email_token_expires_at) > datetime('now')
           LIMIT 1""",
        (token[:12], hash_email_token(token)),
    ).fetchone()
    if not row:
        return False
    db.execute(
        """UPDATE users
           SET email = pending_email,
               email_verified_at = datetime('now'),
               pending_email = NULL,
               pending_email_token_hash = NULL,
               pending_email_token_prefix = NULL,
               pending_email_token_expires_at = NULL,
               email_changed_at = datetime('now')
           WHERE id = ?""",
        (row['id'],),
    )
    return True
