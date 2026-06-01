"""nia-todo: Admin endpoints (users, setup, password management)"""

from typing import Optional
import json
import math
import struct
import uuid
import wave
from io import BytesIO
import urllib.request

from fastapi import APIRouter, Request, Response, HTTPException, Depends
from pydantic import BaseModel
import bcrypt
import hashlib
import secrets

from db import get_db, now_iso
from services.auth import create_admin_jwt_token, verify_admin_token
from services.utils import normalize_email, sanitize_text, validate_email, validate_password, validate_admin_password
from services.audit import log_audit
from services.braindump_config import get_braindump_config, llm_models_url, parse_extra_headers, update_braindump_config
from services.instance_config import get_instance_config, get_public_base_url, update_instance_config
from services.email_config import can_send_email_links, get_email_config, get_password_link_ttl_hours, is_email_configured, update_email_config
from services.email import send_email, send_test_email
from services.two_factor import clear_recovery_codes, get_two_factor_required, set_two_factor_required
from services.email_templates import password_setup_email
from services.websocket import manager
from services.email_verification import clear_pending_email, set_email_or_pending
from services.server_updates import get_update_progress, get_update_status, install_latest_deb_update
from rate_limit import require_login_rate_limit, get_client_ip
from middleware.security import generate_csrf_token, set_csrf_cookie
from errors import api_error, validation_api_error

router = APIRouter(prefix="/api/admin")


def _model_ids_from_llm_models_payload(payload: str) -> set[str]:
    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        return set()
    items = []
    if isinstance(data, dict):
        if isinstance(data.get("data"), list):
            items = data["data"]
        elif isinstance(data.get("models"), list):
            items = data["models"]
    elif isinstance(data, list):
        items = data
    ids: set[str] = set()
    for item in items:
        if isinstance(item, str):
            ids.add(item)
        elif isinstance(item, dict):
            value = item.get("id") or item.get("name") or item.get("model")
            if isinstance(value, str) and value.strip():
                ids.add(value.strip())
    return ids


def _validate_configured_llm_model(payload: str, model: str) -> str | None:
    model = str(model or "").strip()
    ids = _model_ids_from_llm_models_payload(payload)
    if ids and model not in ids:
        sample = ", ".join(sorted(ids)[:8])
        suffix = f" Available: {sample}" if sample else ""
        return f"LLM model is not listed by the endpoint: {model}.{suffix}"
    return None


# ─── Pydantic Models ─────────────────────────────────────────────────────────

class CreateUserRequest(BaseModel):
    username: str
    display_name: str
    email: str
    language: str = "de"
    braindump_enabled: bool = False

class UpdateUserRequest(BaseModel):
    username: Optional[str] = None
    email: Optional[str] = None
    display_name: Optional[str] = None
    braindump_enabled: Optional[bool] = None

class ChangeAdminPasswordRequest(BaseModel):
    old_password: str
    new_password: str

class ResetUserPasswordRequest(BaseModel):
    # Kept for backward-compatible request parsing, but admins no longer set
    # user passwords directly. The endpoint now returns a one-time setup link.
    new_password: Optional[str] = None

class AdminLoginRequest(BaseModel):
    password: str

class InstanceConfigRequest(BaseModel):
    public_base_url: str = ""
    allowed_origins: list[str] = []
    trusted_proxies: list[str] = []

class BrainDumpConfigRequest(BaseModel):
    enabled: bool = False
    llm_provider: str = "openai_compatible"
    llm_base_url: str = ""
    llm_api_key_secret: Optional[str] = None
    llm_model: str = ""
    llm_extra_headers_json: str = ""
    llm_timeout_seconds: float = 180
    system_prompt_mode: str = "default"
    system_prompt_custom: str = ""
    stt_provider: str = "whisper_cpp_remote"
    stt_url: str = ""
    stt_token_secret: Optional[str] = None
    stt_language: str = "auto"
    stt_timeout_seconds: float = 60

class EmailConfigRequest(BaseModel):
    smtp_enabled: bool = False
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_security: str = "starttls"
    smtp_auth_enabled: bool = False
    smtp_username: str = ""
    smtp_password_secret: Optional[str] = None
    mail_from_address: str = ""
    mail_from_name: str = "nia-todo"
    mail_reply_to: str = ""
    password_link_ttl_hours: int = 24

class TestEmailRequest(BaseModel):
    to: str

class TwoFactorPolicyRequest(BaseModel):
    required: bool


# ─── Helpers ─────────────────────────────────────────────────────────────────

from fastapi import Header

def require_admin(authorization: Optional[str] = Header(None)):
    if not verify_admin_token(authorization):
        raise api_error(403, "auth.adminRequired", "Admin authentication required")
    return True


def _password_link_ttl_hours() -> int:
    return get_password_link_ttl_hours()


def _hash_setup_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _make_password_setup_link(request: Request, token: str) -> str:
    base_url = get_public_base_url(request, require_configured=can_send_email_links())
    return f"{base_url}/set-password?token={token}"


def _send_password_setup_email(*, to: str, display_name: str, username: str, link: str, purpose: str, language: str = 'de') -> None:
    subject, text, html = password_setup_email(
        display_name=display_name,
        username=username,
        link=link,
        purpose=purpose,
        expires_hours=_password_link_ttl_hours(),
        language=language,
    )
    send_email(to=to, subject=subject, text=text, html=html)


def replace_active_password_setup_tokens(db, user_id: int, purpose: str) -> None:
    db.execute(
        """UPDATE password_setup_tokens
           SET status = 'replaced', replaced_at = datetime('now')
           WHERE user_id = ?
             AND purpose = ?
             AND status = 'active'
             AND used_at IS NULL""",
        (user_id, purpose),
    )


def create_password_setup_token(db, user_id: int, purpose: str = "reset", requested_by: str = "admin") -> str:
    token = secrets.token_urlsafe(32)
    replace_active_password_setup_tokens(db, user_id, purpose)
    db.execute(
        """INSERT INTO password_setup_tokens
           (user_id, token_hash, token_prefix, purpose, expires_at, created_by_admin, status, requested_by)
           VALUES (?, ?, ?, ?, datetime('now', ?), 1, 'active', ?)""",
        (user_id, _hash_setup_token(token), token[:12], purpose, f"+{_password_link_ttl_hours()} hours", requested_by)
    )
    return token


# ─── Admin Auth ──────────────────────────────────────────────────────────────

@router.post("/login")
def admin_login(data: AdminLoginRequest, request: Request, response: Response, _: None = Depends(require_login_rate_limit)):
    ip = get_client_ip(request)
    with get_db() as db:
        config = db.execute("SELECT admin_token_hash, setup_complete FROM admin_config WHERE id = 1").fetchone()
        if not config or not config["admin_token_hash"] or not config["setup_complete"]:
            raise api_error(400, "admin.setupRequired", "Setup required")
        if not bcrypt.checkpw(data.password.encode(), config["admin_token_hash"].encode()):
            raise api_error(401, "admin.passwordInvalid", "Wrong admin password")
        token = create_admin_jwt_token(db)
        csrf_token = generate_csrf_token()
        set_csrf_cookie(response, csrf_token)
        from rate_limit import rate_limiter
        rate_limiter.record_successful_login(ip)
        return {"access_token": token, "token_type": "bearer", "admin": True, "csrf_token": csrf_token}

@router.post("/logout")
def admin_logout(authorization: Optional[str] = Header(None), _: bool = Depends(require_admin)):
    with get_db() as db:
        db.execute("UPDATE admin_config SET admin_token_version = admin_token_version + 1 WHERE id = 1")
        db.commit()
    return {"message": "Admin signed out. All admin sessions invalidated."}


# ─── Instance Configuration ─────────────────────────────────────────────────

@router.get("/instance-config")
def admin_get_instance_config(_: bool = Depends(require_admin)):
    return get_instance_config()


@router.patch("/instance-config")
def admin_update_instance_config(data: InstanceConfigRequest, request: Request, _: bool = Depends(require_admin)):
    return update_instance_config(
        public_base_url=data.public_base_url,
        allowed_origins=data.allowed_origins,
        trusted_proxies=data.trusted_proxies,
        client_ip=get_client_ip(request),
    )


# ─── BrainDump Configuration ────────────────────────────────────────────────

@router.get("/braindump-config")
def admin_get_braindump_config(_: bool = Depends(require_admin)):
    return get_braindump_config(include_secrets=False)


@router.patch("/braindump-config")
def admin_update_braindump_config(data: BrainDumpConfigRequest, request: Request, _: bool = Depends(require_admin)):
    return update_braindump_config(data.model_dump(), client_ip=get_client_ip(request))


def _build_multipart_form_data(fields: dict[str, str], files: dict[str, tuple[str, bytes, str]]) -> tuple[bytes, str]:
    boundary = f"----nia-todo-admin-stt-probe-{uuid.uuid4().hex}"
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.append(f"--{boundary}\r\n".encode())
        chunks.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        chunks.append(str(value).encode("utf-8"))
        chunks.append(b"\r\n")
    for name, (filename, data, content_type) in files.items():
        chunks.append(f"--{boundary}\r\n".encode())
        chunks.append(f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'.encode())
        chunks.append(f"Content-Type: {content_type}\r\n\r\n".encode())
        chunks.append(data)
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def _admin_stt_probe_wav() -> bytes:
    # Short synthetic tone: enough to prove the configured endpoint accepts and processes real audio.
    sample_rate = 16000
    duration_seconds = 0.35
    frames = int(sample_rate * duration_seconds)
    buffer = BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        samples = bytearray()
        for index in range(frames):
            value = int(0.18 * 32767 * math.sin(2 * math.pi * 440 * index / sample_rate))
            samples.extend(struct.pack("<h", value))
        wav.writeframes(bytes(samples))
    return buffer.getvalue()


def _validate_stt_probe_response(payload: bytes, content_type: str) -> str:
    text = payload.decode("utf-8", errors="replace").strip()
    if "json" not in content_type.lower():
        return text[:400]
    try:
        data = json.loads(text or "{}")
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"STT returned invalid JSON: {exc}") from exc
    transcript = data.get("text") if isinstance(data, dict) else None
    if not isinstance(transcript, str):
        raise RuntimeError("STT response is missing text")
    return text[:400]


def _probe_remote_stt(config: dict) -> tuple[bool, str, str]:
    stt_url = str(config.get("stt_url") or "").strip()
    if not stt_url:
        return False, "STT URL is not configured", ""
    fields = {
        "response_format": "json",
        "temperature": "0.0",
        "temperature_inc": "0.0",
    }
    language = str(config.get("stt_language") or "").strip()
    if language and language.lower() != "auto":
        fields["language"] = language
    body, multipart_type = _build_multipart_form_data(
        fields,
        {"file": ("nia-todo-stt-probe.wav", _admin_stt_probe_wav(), "audio/wav")},
    )
    headers = {"Content-Type": multipart_type}
    stt_token = str(config.get("stt_token") or "").strip()
    if stt_token:
        headers["Authorization"] = f"Bearer {stt_token}"
    req = urllib.request.Request(stt_url, data=body, headers=headers, method="POST")
    timeout = min(float(config.get("stt_timeout_seconds") or 60), 30.0)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        payload = response.read()
        sample = _validate_stt_probe_response(payload, response.headers.get("content-type", ""))
    return True, "STT endpoint accepted and processed a probe audio request", sample


@router.post("/braindump-config/test")
def admin_test_braindump_config(_: bool = Depends(require_admin)):
    config = get_braindump_config(include_secrets=True)
    if not config.get("enabled"):
        return {
            "llm": {"ok": False, "message": "BrainDump is disabled"},
            "stt": {"ok": False, "message": "BrainDump is disabled"},
        }
    result = {
        "llm": {"ok": False, "message": "not tested"},
        "stt": {"ok": False, "message": "not tested"},
    }

    token = str(config.get("llm_api_key") or "").strip()
    if not str(config.get("llm_base_url") or "").strip():
        result["llm"] = {"ok": False, "message": "LLM base URL is not configured"}
    elif not str(config.get("llm_model") or "").strip():
        result["llm"] = {"ok": False, "message": "LLM model is not configured"}
    else:
        try:
            headers = {}
            if token:
                headers["Authorization"] = f"Bearer {token}"
            headers.update(parse_extra_headers(str(config.get("llm_extra_headers_json") or "")))
            req = urllib.request.Request(llm_models_url(config), headers=headers)
            with urllib.request.urlopen(req, timeout=10) as response:
                payload = response.read().decode("utf-8", errors="replace")
            model_error = _validate_configured_llm_model(payload, str(config.get("llm_model") or ""))
            provider_name = "Ollama API" if str(config.get("llm_provider") or "") == "ollama" else "LLM endpoint"
            if model_error:
                result["llm"] = {"ok": False, "message": model_error, "sample": payload[:400]}
            else:
                result["llm"] = {"ok": True, "message": f"{provider_name} reachable", "sample": payload[:400]}
        except Exception as exc:
            result["llm"] = {"ok": False, "message": str(exc)}

    if config.get("stt_provider") == "local_whisper_cpp":
        result["stt"] = {"ok": True, "message": "Local whisper.cpp provider selected; runtime availability is checked when audio is processed"}
    else:
        try:
            ok, message, sample = _probe_remote_stt(config)
            result["stt"] = {"ok": ok, "message": message}
            if sample:
                result["stt"]["sample"] = sample
        except Exception as exc:
            result["stt"] = {"ok": False, "message": str(exc)}
    return result


# ─── Email Configuration ────────────────────────────────────────────────────

@router.get("/email-config")
def admin_get_email_config(_: bool = Depends(require_admin)):
    return get_email_config()


@router.patch("/email-config")
def admin_update_email_config(data: EmailConfigRequest, request: Request, _: bool = Depends(require_admin)):
    return update_email_config(data.model_dump(), client_ip=get_client_ip(request))


@router.post("/email-config/test")
def admin_send_test_email(data: TestEmailRequest, request: Request, _: bool = Depends(require_admin)):
    email = sanitize_text(data.to)
    email_error = validate_email(email)
    if email_error:
        raise validation_api_error(email_error)
    with get_db() as db:
        try:
            send_test_email(email)
            log_audit(db, "email_test_sent", ip_address=get_client_ip(request), details=f"to={email}")
        except Exception as exc:
            log_audit(db, "email_test_failed", ip_address=get_client_ip(request), details=f"to={email}; error={type(exc).__name__}")
            raise
    return {"message": "Test email sent."}


# ─── Server Updates ──────────────────────────────────────────────────────────

@router.get("/server-update")
def admin_get_server_update_status(_: bool = Depends(require_admin)):
    return get_update_status()


@router.get("/server-update/progress")
def admin_get_server_update_progress(_: bool = Depends(require_admin)):
    return get_update_progress()


@router.post("/server-update/install")
def admin_install_server_update(request: Request, _: bool = Depends(require_admin)):
    with get_db() as db:
        try:
            result = install_latest_deb_update()
            log_audit(db, "server_update_started", ip_address=get_client_ip(request), details=f"target={result.get('target_version')}; pid={result.get('pid')}")
            db.commit()
            if not result.get("started"):
                raise api_error(500, "serverUpdate.installFailed", result.get("output") or "Server update failed")
            return result
        except RuntimeError as exc:
            log_audit(db, "server_update_blocked", ip_address=get_client_ip(request), details=str(exc)[:500])
            db.commit()
            raise api_error(400, "serverUpdate.blocked", str(exc))


# ─── Two-Factor Policy ───────────────────────────────────────────────────────

@router.get("/2fa-policy")
def admin_get_two_factor_policy(_: bool = Depends(require_admin)):
    with get_db() as db:
        return {"required": get_two_factor_required(db)}


@router.patch("/2fa-policy")
def admin_set_two_factor_policy(data: TwoFactorPolicyRequest, request: Request, _: bool = Depends(require_admin)):
    with get_db() as db:
        set_two_factor_required(db, data.required, actor="admin-ui")
        log_audit(db, "two_factor_policy_changed", ip_address=get_client_ip(request), details=f"required={data.required}; actor=admin-ui")
        db.commit()
        return {"required": data.required}


@router.post("/users/{user_id}/2fa/reset")
async def admin_reset_user_two_factor(user_id: int, request: Request, _: bool = Depends(require_admin)):
    with get_db() as db:
        user = db.execute("SELECT id, username FROM users WHERE id = ?", (user_id,)).fetchone()
        if not user:
            raise api_error(404, "user.notFound", "User not found")
        db.execute(
            """UPDATE users SET two_factor_enabled = 0, two_factor_totp_secret = NULL, two_factor_recovery_hashes = NULL,
               two_factor_recovery_generated_at = NULL, two_factor_updated_at = datetime('now'),
               two_factor_remember_version = COALESCE(two_factor_remember_version, 1) + 1,
               token_version = COALESCE(token_version, 1) + 1 WHERE id = ?""",
            (user_id,),
        )
        clear_recovery_codes(db, user_id)
        db.execute("UPDATE passkeys SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL", (user_id,))
        db.execute("UPDATE trusted_devices SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL", (user_id,))
        log_audit(db, "two_factor_reset_by_admin", user_id=user_id, ip_address=get_client_ip(request), details=f"username={user['username']}")
        db.commit()
    await manager.broadcast_to_user(user_id, {"type": "session_invalidated", "reason": "two_factor_reset"})
    await manager.disconnect_user(user_id, code=4001, reason="two_factor_reset")
    return {"reset": user_id}


# ─── User Management ─────────────────────────────────────────────────────────

@router.post("/users")
def create_user(data: CreateUserRequest, request: Request, _: bool = Depends(require_admin)):
    data.username = sanitize_text(data.username)
    data.display_name = sanitize_text(data.display_name)
    data.email = normalize_email(sanitize_text(data.email))
    data.language = (data.language or 'de').strip().lower()
    if data.language not in {'de', 'en'}:
        raise api_error(400, 'language.invalid', 'Invalid language')
    email_error = validate_email(data.email)
    if email_error:
        raise validation_api_error(email_error)
    with get_db() as db:
        existing = db.execute("SELECT id FROM users WHERE username = ?", (data.username,)).fetchone()
        if existing:
            raise HTTPException(409, "Username already exists")
        if data.email:
            existing_email = db.execute("SELECT id FROM users WHERE lower(email) = lower(?) OR lower(pending_email) = lower(?)", (data.email, data.email)).fetchone()
            if existing_email:
                raise HTTPException(409, "Email already exists")
        unusable_password_hash = bcrypt.hashpw(secrets.token_urlsafe(32).encode(), bcrypt.gensalt()).decode()
        c = db.execute(
            "INSERT INTO users (username, display_name, email, password_hash, is_admin, language, braindump_enabled) VALUES (?, ?, ?, ?, 0, ?, ?)",
            (data.username, data.display_name, data.email, unusable_password_hash, data.language, 1 if data.braindump_enabled else 0)
        )
        user_id = c.lastrowid

        # Create default workspace and projects for the new user
        workspace = db.execute(
            "INSERT INTO workspaces (name, color, icon, sort_order, user_id, is_default, updated_at) VALUES (?, ?, ?, 0, ?, 1, datetime('now'))",
            ('Personal', '#10b981', 'home', user_id)
        )
        workspace_id = workspace.lastrowid
        default_projects = [
            ('Inbox', '#64748b', 'inbox', 0, 1),
            ('Personal', '#10b981', None, 1, 0),
            ('Work', '#3b82f6', None, 2, 0),
            ('Shopping', '#f59e0b', None, 3, 0),
        ]
        for name, color, icon, sort_order, is_inbox in default_projects:
            db.execute(
                "INSERT INTO projects (name, color, icon, sort_order, user_id, is_inbox, workspace_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))",
                (name, color, icon, sort_order, user_id, is_inbox, workspace_id)
            )

        token = create_password_setup_token(db, user_id, "invite")
        link = _make_password_setup_link(request, token)
        emailed = False
        db.commit()
        if is_email_configured():
            try:
                _send_password_setup_email(
                    to=data.email,
                    display_name=data.display_name,
                    username=data.username,
                    link=link,
                    purpose="invite",
                    language=data.language,
                )
                emailed = True
            except Exception:
                log_audit(db, "password_setup_email_failed", user_id=user_id, details="purpose=invite; manual_link_returned=true")
                db.commit()
        log_audit(db, "user_created", user_id=user_id, details=f"username={data.username}")
        if emailed:
            log_audit(db, "password_setup_email_sent", user_id=user_id, details="purpose=invite")
        db.commit()
        response = {
            "id": user_id,
            "username": data.username,
            "display_name": data.display_name,
            "email": data.email,
            "language": data.language,
            "braindump_enabled": bool(data.braindump_enabled),
            "created_at": now_iso(),
            "password_setup_expires_hours": _password_link_ttl_hours(),
            "password_setup_delivery": "email" if emailed else "manual",
            "message": "Invitation email sent." if emailed else "Password link created.",
        }
        if not emailed:
            response["password_setup_url"] = link
        return response

@router.get("/users")
def list_users(_: bool = Depends(require_admin)):
    with get_db() as db:
        rows = db.execute("""
            SELECT u.id, u.username, u.display_name, u.email, u.email_verified_at, u.email_trust_source,
                   u.pending_email, u.password_hash IS NOT NULL AS password_configured, u.is_admin, u.language, u.created_at,
                   COALESCE(u.braindump_enabled, 0) AS braindump_enabled,
                   COALESCE(u.two_factor_enabled, 0) AS two_factor_enabled,
                   CASE WHEN u.two_factor_totp_secret IS NOT NULL AND u.two_factor_totp_secret != '' THEN 1 ELSE 0 END AS has_totp,
                   CASE WHEN u.two_factor_recovery_hashes IS NOT NULL AND u.two_factor_recovery_hashes != '[]' THEN 1 ELSE 0 END AS has_recovery_codes,
                   (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id AND p.revoked_at IS NULL) AS passkey_count,
                   (SELECT COUNT(*) FROM api_keys ak WHERE ak.user_id = u.id AND ak.revoked_at IS NULL) AS api_key_count,
                   (SELECT MAX(COALESCE(s.last_used_at, s.created_at)) FROM user_sessions s WHERE s.user_id = u.id) AS last_active_at
            FROM users u
            ORDER BY u.id
        """).fetchall()
        email_mfa_available = can_send_email_links()
        users = []
        for row in rows:
            item = dict(row)
            item["has_email_fallback"] = bool(email_mfa_available and item.get("email") and item.get("email_verified_at"))
            users.append(item)
        return {"users": users, "two_factor_required": get_two_factor_required(db)}

@router.patch("/users/{user_id}")
def update_user(user_id: int, data: UpdateUserRequest, request: Request, _: bool = Depends(require_admin)):
    username = sanitize_text(data.username) if data.username is not None else None
    email = normalize_email(sanitize_text(data.email)) if data.email is not None else None
    display_name = sanitize_text(data.display_name) if data.display_name is not None else None
    if username is not None:
        if not username:
            raise api_error(400, "user.usernameRequired", "Username is required")
        if len(username) > 80:
            raise api_error(400, "user.usernameTooLong", "Username is too long")
    if email is not None:
        email_error = validate_email(email)
        if email_error:
            raise validation_api_error(email_error)
    with get_db() as db:
        user = db.execute("SELECT id, username, email, COALESCE(braindump_enabled, 0) AS braindump_enabled FROM users WHERE id = ?", (user_id,)).fetchone()
        if not user:
            raise api_error(404, "user.notFound", "User not found")
        if username is not None and username != user["username"]:
            existing_username = db.execute("SELECT id FROM users WHERE username = ? AND id != ?", (username, user_id)).fetchone()
            if existing_username:
                raise api_error(409, "user.usernameExists", "Username already exists")
            db.execute("UPDATE users SET username = ? WHERE id = ?", (username, user_id))
            log_audit(db, "username_changed_by_admin", user_id=user_id, ip_address=get_client_ip(request), details=f"old_username={user['username']}; new_username={username}")
        if email is not None:
            existing_email = db.execute("SELECT id FROM users WHERE (lower(email) = lower(?) OR lower(pending_email) = lower(?)) AND id != ?", (email, email, user_id)).fetchone()
            if existing_email:
                raise HTTPException(409, "Email already exists")
        if display_name is not None:
            db.execute("UPDATE users SET display_name = ? WHERE id = ?", (display_name, user_id))
        result = {"email": user["email"], "pending_email": None, "email_verification_required": False}
        if email is not None:
            result = {"email": email, "pending_email": None, "email_verification_required": False}
            if email != user['email']:
                result = set_email_or_pending(db, user_id=user_id, email=email, request=request, requested_by="admin")
                verification_email = result.pop("_verification_email", None)
                if verification_email:
                    db.commit()
                    try:
                        send_email(**verification_email)
                    except Exception:
                        clear_pending_email(db, user_id=user_id)
                        log_audit(db, "email_verification_email_failed", user_id=user_id, details="requested_by=admin")
                        db.commit()
                        raise api_error(400, "email.changeVerificationFailed", "The confirmation email could not be sent. The email was not changed.")
                log_audit(db, "email_verification_requested" if result.get("email_verification_required") else "email_changed_direct", user_id=user_id, details=f"requested_by=admin; delivery={result.get('email_verification_delivery')}")
        if data.braindump_enabled is not None:
            enabled = 1 if data.braindump_enabled else 0
            if enabled != int(user["braindump_enabled"] or 0):
                db.execute("UPDATE users SET braindump_enabled = ? WHERE id = ?", (enabled, user_id))
                log_audit(db, "braindump_access_changed", user_id=user_id, ip_address=get_client_ip(request), details=f"enabled={bool(enabled)}")
        db.commit()
        return {"id": user_id, "username": username if username is not None else user["username"], "display_name": display_name, "braindump_enabled": bool(data.braindump_enabled) if data.braindump_enabled is not None else bool(user["braindump_enabled"]), **result}

@router.delete("/users/{user_id}")
def delete_user(user_id: int, _: bool = Depends(require_admin)):
    with get_db() as db:
        user = db.execute("SELECT is_admin FROM users WHERE id = ?", (user_id,)).fetchone()
        if not user:
            raise api_error(404, "user.notFound", "User not found")
        if user['is_admin']:
            raise api_error(400, "user.adminDeleteForbidden", "Cannot delete admin user")
        db.execute("DELETE FROM api_keys WHERE user_id = ?", (user_id,))
        db.execute("DELETE FROM reminders WHERE todo_id IN (SELECT id FROM todos WHERE user_id = ?)", (user_id,))
        db.execute("DELETE FROM sections WHERE user_id = ?", (user_id,))
        db.execute("DELETE FROM todos WHERE user_id = ?", (user_id,))
        db.execute("DELETE FROM projects WHERE user_id = ? AND COALESCE(is_inbox, 0) = 0", (user_id,))
        db.execute("DELETE FROM users WHERE id = ?", (user_id,))
        db.commit()
        return {"deleted": user_id}


# ─── Password Management ──────────────────────────────────────────────────────

@router.post("/change-password")
def change_admin_password(data: ChangeAdminPasswordRequest, _: bool = Depends(require_admin)):
    error = validate_admin_password(data.new_password)
    if error:
        raise validation_api_error(error)
    with get_db() as db:
        config = db.execute("SELECT admin_token_hash FROM admin_config WHERE id = 1").fetchone()
        if not config or not config['admin_token_hash']:
            raise api_error(500, "admin.configMissing", "Admin configuration not found")
        if not bcrypt.checkpw(data.old_password.encode(), config['admin_token_hash'].encode()):
            raise api_error(401, "admin.oldPasswordInvalid", "Wrong current admin password")
        new_hash = bcrypt.hashpw(data.new_password.encode(), bcrypt.gensalt()).decode()
        db.execute(
            "UPDATE admin_config SET admin_token_hash = ?, admin_token_version = admin_token_version + 1 WHERE id = 1",
            (new_hash,)
        )
        db.commit()
    return {"message": "Admin password changed. Please sign in again."}

@router.post("/users/{user_id}/change-password")
def admin_change_user_password(user_id: int, data: ResetUserPasswordRequest, request: Request, _: bool = Depends(require_admin)):
    return admin_create_user_password_link(user_id, request)


@router.post("/users/{user_id}/password-link")
def admin_create_user_password_link(user_id: int, request: Request, _: bool = Depends(require_admin)):
    with get_db() as db:
        user = db.execute("SELECT id, username, display_name, email, email_verified_at, language FROM users WHERE id = ?", (user_id,)).fetchone()
        if not user:
            raise api_error(404, "user.notFound", "User not found")
        token = create_password_setup_token(db, user_id, "reset")
        link = _make_password_setup_link(request, token)
        emailed = False
        db.commit()
        if is_email_configured() and user['email'] and user['email_verified_at']:
            try:
                _send_password_setup_email(
                    to=user['email'],
                    display_name=user['display_name'],
                    username=user['username'],
                    link=link,
                    purpose="reset",
                    language=user['language'] or 'de',
                )
                emailed = True
            except Exception:
                log_audit(db, "password_setup_email_failed", user_id=user_id, details="purpose=reset; manual_link_returned=true")
                db.commit()
        log_audit(db, "password_setup_link_created", user_id=user_id, details=f"username={user['username']}")
        if emailed:
            log_audit(db, "password_setup_email_sent", user_id=user_id, details="purpose=reset")
        db.commit()
    response = {
        "message": "Password email sent." if emailed else "Password link created.",
        "password_setup_expires_hours": _password_link_ttl_hours(),
        "password_setup_delivery": "email" if emailed else "manual",
    }
    if not emailed:
        response["password_setup_url"] = link
    return response
