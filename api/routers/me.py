"""nia-todo: User self-service endpoints"""

from pathlib import Path
from fastapi import APIRouter, HTTPException, Depends, Request
from pydantic import BaseModel
from PIL import Image, UnidentifiedImageError
import bcrypt
import io
import shutil
import subprocess
import tempfile

try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
    PILLOW_HEIC_SUPPORTED = True
except ImportError:
    PILLOW_HEIC_SUPPORTED = False

HEIF_CONVERT_BIN = shutil.which("heif-convert")
HEIC_SUPPORTED = PILLOW_HEIC_SUPPORTED or bool(HEIF_CONVERT_BIN)

from db import DB_PATH, get_db, now_iso
from routers.auth import require_auth
from services.audit import log_audit
from services.email import send_email
from services.email_verification import clear_pending_email, set_email_or_pending, verify_pending_email
from services.utils import normalize_email, sanitize_text, validate_email, validate_password

router = APIRouter(prefix="/api/me")

AVATAR_DIR = DB_PATH.parent / "avatars"
AVATAR_SIZE = 256
MAX_AVATAR_BYTES = 5 * 1024 * 1024
ALLOWED_AVATAR_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"}


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str

class UpdateEmailRequest(BaseModel):
    email: str

class UpdateProfileRequest(BaseModel):
    display_name: str


def _avatar_url(user_id: int) -> str:
    return f"/api/avatars/user-{user_id}.webp"


def _load_avatar_image(body: bytes, content_type: str) -> Image.Image:
    try:
        image = Image.open(io.BytesIO(body))
        image.verify()
        return Image.open(io.BytesIO(body)).convert("RGB")
    except (UnidentifiedImageError, OSError, SyntaxError):
        if content_type not in {"image/heic", "image/heif"} or not HEIF_CONVERT_BIN:
            raise

    with tempfile.TemporaryDirectory() as tmpdir:
        input_path = Path(tmpdir) / "avatar.heic"
        output_path = Path(tmpdir) / "avatar.png"
        input_path.write_bytes(body)
        result = subprocess.run(
            [HEIF_CONVERT_BIN, str(input_path), str(output_path)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
            check=False,
        )
        if result.returncode != 0 or not output_path.exists():
            raise UnidentifiedImageError("HEIC conversion failed")
        return Image.open(output_path).convert("RGB")


@router.patch("/profile")
def update_own_profile(data: UpdateProfileRequest, user_id: int = Depends(require_auth)):
    display_name = sanitize_text(data.display_name)
    if not display_name:
        raise HTTPException(400, "Anzeigename ist erforderlich")
    if len(display_name) > 80:
        raise HTTPException(400, "Anzeigename ist zu lang")
    with get_db() as db:
        user = db.execute("SELECT id, username, email, email_trust_source, avatar_url, avatar_updated_at, is_admin FROM users WHERE id = ?", (user_id,)).fetchone()
        if not user:
            raise HTTPException(404, "User not found")
        db.execute("UPDATE users SET display_name = ? WHERE id = ?", (display_name, user_id))
        db.commit()
    return {
        "id": user_id,
        "username": user["username"],
        "display_name": display_name,
        "email": user["email"],
        "email_trust_source": user["email_trust_source"],
        "avatar_url": user["avatar_url"],
        "avatar_updated_at": user["avatar_updated_at"],
        "is_admin": bool(user["is_admin"]),
    }


@router.put("/avatar")
async def upload_own_avatar(request: Request, user_id: int = Depends(require_auth)):
    content_type = (request.headers.get("content-type") or "").split(";", 1)[0].lower()
    if content_type in {"image/heic", "image/heif"} and not HEIC_SUPPORTED:
        raise HTTPException(400, "HEIC wird auf diesem Server noch nicht unterstützt")
    if content_type not in ALLOWED_AVATAR_CONTENT_TYPES:
        raise HTTPException(400, "Bitte ein gültiges Bild hochladen")

    body = await request.body()
    if not body:
        raise HTTPException(400, "Bild ist erforderlich")
    if len(body) > MAX_AVATAR_BYTES:
        raise HTTPException(400, "Bild ist zu groß")

    try:
        image = _load_avatar_image(body, content_type)
    except (UnidentifiedImageError, OSError, SyntaxError, subprocess.SubprocessError):
        raise HTTPException(400, "Bitte ein gültiges Bild hochladen")

    width, height = image.size
    side = min(width, height)
    left = (width - side) // 2
    top = (height - side) // 2
    image = image.crop((left, top, left + side, top + side)).resize((AVATAR_SIZE, AVATAR_SIZE), Image.LANCZOS)

    AVATAR_DIR.mkdir(parents=True, exist_ok=True)
    avatar_path = AVATAR_DIR / f"user-{user_id}.webp"
    tmp_path = avatar_path.with_suffix(".webp.tmp")
    image.save(tmp_path, "WEBP", quality=88, method=6)
    tmp_path.replace(avatar_path)

    avatar_url = _avatar_url(user_id)
    updated_at = now_iso()
    with get_db() as db:
        user = db.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
        if not user:
            raise HTTPException(404, "User not found")
        db.execute("UPDATE users SET avatar_url = ?, avatar_updated_at = ? WHERE id = ?", (avatar_url, updated_at, user_id))
        db.commit()
    return {"avatar_url": avatar_url, "avatar_updated_at": updated_at}


@router.post("/email/verify")
def verify_own_pending_email(data: dict, user_id: int = Depends(require_auth)):
    token = sanitize_text(data.get("token") if isinstance(data, dict) else "")
    with get_db() as db:
        if not verify_pending_email(db, token, user_id=user_id):
            raise HTTPException(404, "Bestätigungslink ist ungültig oder abgelaufen")
        log_audit(db, "email_verification_completed", user_id=user_id)
        db.commit()
    return {"message": "E-Mail bestätigt."}


@router.patch("/email")
def update_own_email(data: UpdateEmailRequest, request: Request, user_id: int = Depends(require_auth)):
    email = normalize_email(sanitize_text(data.email))
    email_error = validate_email(email)
    if email_error:
        raise HTTPException(400, email_error)
    with get_db() as db:
        user = db.execute("SELECT id, email FROM users WHERE id = ?", (user_id,)).fetchone()
        if not user:
            raise HTTPException(404, "User not found")
        if email == user['email']:
            return {"email": email, "pending_email": None, "email_verification_required": False}
        existing = db.execute("SELECT id FROM users WHERE (lower(email) = lower(?) OR lower(pending_email) = lower(?)) AND id != ?", (email, email, user_id)).fetchone()
        if existing:
            log_audit(db, "email_change_rejected", user_id=user_id, details="reason=unavailable")
            db.commit()
            return {
                "email": user['email'],
                "pending_email": None,
                "email_verification_required": False,
                "email_verification_delivery": "unavailable",
                "message": "E-Mail konnte nicht geändert werden.",
            }
        result = set_email_or_pending(db, user_id=user_id, email=email, request=request, requested_by="user")
        verification_email = result.pop("_verification_email", None)
        if verification_email:
            db.commit()
            try:
                send_email(**verification_email)
            except Exception:
                clear_pending_email(db, user_id=user_id)
                log_audit(db, "email_verification_email_failed", user_id=user_id, details="requested_by=user")
                db.commit()
                raise HTTPException(400, "Bestätigungsmail konnte nicht gesendet werden. E-Mail wurde nicht geändert.")
        log_audit(db, "email_verification_requested" if result.get("email_verification_required") else "email_changed_direct", user_id=user_id, details=f"delivery={result.get('email_verification_delivery')}")
        db.commit()
    return result


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
