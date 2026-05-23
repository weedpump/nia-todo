"""nia-todo: Public one-time password setup/reset endpoints"""

import bcrypt
import hashlib
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from db import get_db
from services.utils import validate_password

router = APIRouter(prefix="/api/password-setup")


class CompletePasswordSetupRequest(BaseModel):
    token: str
    password: str


def _hash_setup_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _get_valid_token(db, token: str):
    if not token or len(token) < 24:
        return None
    return db.execute(
        """SELECT pst.*, u.username, u.display_name
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


@router.get("/validate")
def validate_password_setup_token(token: str):
    with get_db() as db:
        row = _get_valid_token(db, token)
        if not row:
            raise HTTPException(404, "Link ist ungültig oder abgelaufen")
        return {
            "valid": True,
            "username": row['username'],
            "display_name": row['display_name'],
            "purpose": row['purpose'],
            "expires_at": row['expires_at'],
        }


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
