"""nia-todo: User self-service endpoints"""

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
import bcrypt

from db import get_db
from routers.auth import require_auth
from services.utils import sanitize_text, validate_email, validate_password

router = APIRouter(prefix="/api/me")


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str

class UpdateEmailRequest(BaseModel):
    email: str


@router.patch("/email")
def update_own_email(data: UpdateEmailRequest, user_id: int = Depends(require_auth)):
    email = sanitize_text(data.email)
    email_error = validate_email(email)
    if email_error:
        raise HTTPException(400, email_error)
    with get_db() as db:
        user = db.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
        if not user:
            raise HTTPException(404, "User not found")
        existing = db.execute("SELECT id FROM users WHERE email = ? AND id != ?", (email, user_id)).fetchone()
        if existing:
            raise HTTPException(409, "Email already exists")
        db.execute("UPDATE users SET email = ? WHERE id = ?", (email, user_id))
        db.commit()
    return {"email": email}


@router.post("/change-password")
def change_own_password(data: ChangePasswordRequest, user_id: int = Depends(require_auth)):
    error = validate_password(data.new_password)
    if error:
        raise HTTPException(400, error)
    with get_db() as db:
        row = db.execute("SELECT password_hash FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            raise HTTPException(404, "User not found")
        if not bcrypt.checkpw(data.old_password.encode(), row['password_hash'].encode()):
            raise HTTPException(401, "Altes Passwort ist falsch")
        new_hash = bcrypt.hashpw(data.new_password.encode(), bcrypt.gensalt()).decode()
        db.execute(
            "UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?",
            (new_hash, user_id)
        )
        db.commit()
    return {"message": "Passwort geändert. Bitte melde dich erneut an."}
