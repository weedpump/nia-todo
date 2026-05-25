"""nia-todo: Two-factor authentication helpers.

Supports dependency-free TOTP, e-mail fallback codes, recovery codes,
remembered devices and lightweight WebAuthn/passkey challenge storage.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import struct
import time
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import quote

import bcrypt

from services.audit import log_audit
from services.email import send_email
from services.email_templates import two_factor_code_email
from services.email_config import can_send_email_links

APP_NAME = "nia-todo"
TOTP_PERIOD = 30
TOTP_DIGITS = 6
TOTP_WINDOW = 1
CHALLENGE_TTL_SECONDS = 10 * 60
EMAIL_CODE_TTL_SECONDS = 10 * 60
REMEMBER_DEVICE_DAYS = 30
REAUTH_MAX_AGE_SECONDS = 10 * 60
RECOVERY_CODE_COUNT = 10


def utc_ts() -> int:
    return int(time.time())


def utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def bcrypt_hash(value: str) -> str:
    return bcrypt.hashpw(value.encode(), bcrypt.gensalt()).decode()


def bcrypt_check(value: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(value.encode(), hashed.encode())
    except Exception:
        return False


def generate_totp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _totp(secret: str, counter: int) -> str:
    padded = secret.upper() + ("=" * ((8 - len(secret) % 8) % 8))
    key = base64.b32decode(padded, casefold=True)
    msg = struct.pack(">Q", counter)
    digest = hmac.new(key, msg, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code_int = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7fffffff
    return str(code_int % (10 ** TOTP_DIGITS)).zfill(TOTP_DIGITS)


def matching_totp_counter(secret: str, code: str, now: Optional[int] = None) -> Optional[int]:
    clean = "".join(ch for ch in (code or "") if ch.isdigit())
    if len(clean) != TOTP_DIGITS:
        return None
    current = int((now or utc_ts()) / TOTP_PERIOD)
    for drift in range(-TOTP_WINDOW, TOTP_WINDOW + 1):
        counter = current + drift
        if hmac.compare_digest(_totp(secret, counter), clean):
            return counter
    return None


def verify_totp(secret: str, code: str, now: Optional[int] = None) -> bool:
    return matching_totp_counter(secret, code, now) is not None


def provisioning_uri(secret: str, username: str) -> str:
    label = quote(f"{APP_NAME}:{username}")
    issuer = quote(APP_NAME)
    return f"otpauth://totp/{label}?secret={secret}&issuer={issuer}&algorithm=SHA1&digits={TOTP_DIGITS}&period={TOTP_PERIOD}"


def get_two_factor_required(db) -> bool:
    row = db.execute("SELECT value FROM app_config WHERE key = 'two_factor_required'").fetchone()
    return bool(row and str(row["value"]).lower() == "true")


def set_two_factor_required(db, enabled: bool, actor: str = "admin") -> None:
    db.execute(
        "INSERT INTO app_config (key, value) VALUES ('two_factor_required', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ("true" if enabled else "false",),
    )
    log_audit(db, "two_factor_policy_changed", details=f"required={enabled}; actor={actor}")


def user_mfa_state(db, user_id: int) -> dict:
    row = db.execute(
        """SELECT id, username, email, email_verified_at, two_factor_enabled, two_factor_totp_secret,
                  two_factor_recovery_hashes, two_factor_remember_version
           FROM users WHERE id = ?""",
        (user_id,),
    ).fetchone()
    if not row:
        return {}
    recovery = []
    try:
        recovery = json.loads(row["two_factor_recovery_hashes"] or "[]")
    except Exception:
        recovery = []
    has_totp = bool(row["two_factor_totp_secret"])
    has_recovery = bool(recovery)
    has_email = bool(row["email"] and row["email_verified_at"] and can_send_email_links())
    passkey_count = db.execute("SELECT COUNT(*) AS c FROM passkeys WHERE user_id = ? AND revoked_at IS NULL", (user_id,)).fetchone()["c"]
    return {
        "user_id": user_id,
        "username": row["username"],
        "enabled": bool(row["two_factor_enabled"]),
        "required": get_two_factor_required(db),
        "has_totp": has_totp,
        "has_recovery_codes": has_recovery,
        "recovery_codes_remaining": len(recovery),
        "has_email_fallback": has_email,
        "has_passkey": passkey_count > 0,
        "passkey_count": passkey_count,
        "remember_version": row["two_factor_remember_version"] or 1,
    }


def mfa_required_for_user(db, user_id: int) -> bool:
    state = user_mfa_state(db, user_id)
    return bool(state.get("enabled") or state.get("required"))


def available_methods(db, user_id: int) -> list[str]:
    state = user_mfa_state(db, user_id)
    methods = []
    if state.get("has_totp"):
        methods.append("totp")
    if state.get("has_passkey"):
        methods.append("passkey")
    if state.get("has_recovery_codes"):
        methods.append("recovery_code")
    if state.get("has_email_fallback") and not (state.get("has_totp") or state.get("has_passkey")):
        methods.append("email")
    return methods


def clear_recovery_codes(db, user_id: int) -> None:
    db.execute("DELETE FROM two_factor_recovery_codes WHERE user_id = ?", (user_id,))
    db.execute(
        """UPDATE users
           SET two_factor_recovery_hashes = NULL,
               two_factor_recovery_generated_at = NULL,
               two_factor_updated_at = datetime('now')
           WHERE id = ?""",
        (user_id,),
    )


def clear_recovery_codes_if_no_primary_factor(db, user_id: int) -> bool:
    row = db.execute("SELECT two_factor_totp_secret FROM users WHERE id = ?", (user_id,)).fetchone()
    has_totp = bool(row and row["two_factor_totp_secret"])
    passkey_count = db.execute(
        "SELECT COUNT(*) AS c FROM passkeys WHERE user_id = ? AND revoked_at IS NULL",
        (user_id,),
    ).fetchone()["c"]
    if has_totp or passkey_count > 0:
        return False
    clear_recovery_codes(db, user_id)
    db.execute("UPDATE users SET two_factor_enabled = 0, two_factor_updated_at = datetime('now') WHERE id = ?", (user_id,))
    return True


def create_recovery_codes(db, user_id: int) -> list[str]:
    codes = [f"{secrets.token_hex(4)}-{secrets.token_hex(4)}" for _ in range(RECOVERY_CODE_COUNT)]
    hashes = [bcrypt_hash(code) for code in codes]
    db.execute("DELETE FROM two_factor_recovery_codes WHERE user_id = ?", (user_id,))
    db.executemany(
        "INSERT INTO two_factor_recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, datetime('now'))",
        [(user_id, hashed) for hashed in hashes],
    )
    db.execute(
        "UPDATE users SET two_factor_recovery_hashes = ?, two_factor_recovery_generated_at = datetime('now'), two_factor_updated_at = datetime('now') WHERE id = ?",
        (json.dumps(hashes), user_id),
    )
    log_audit(db, "two_factor_recovery_codes_generated", user_id=user_id)
    return codes


def _ensure_recovery_code_rows(db, user_id: int) -> None:
    existing = db.execute("SELECT 1 FROM two_factor_recovery_codes WHERE user_id = ? LIMIT 1", (user_id,)).fetchone()
    if existing:
        return
    row = db.execute("SELECT two_factor_recovery_hashes FROM users WHERE id = ?", (user_id,)).fetchone()
    hashes = json.loads(row["two_factor_recovery_hashes"] or "[]") if row else []
    if not hashes:
        return
    db.executemany(
        "INSERT INTO two_factor_recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, datetime('now'))",
        [(user_id, hashed) for hashed in hashes],
    )


def _sync_legacy_recovery_hashes(db, user_id: int) -> None:
    rows = db.execute(
        "SELECT code_hash FROM two_factor_recovery_codes WHERE user_id = ? AND consumed_at IS NULL ORDER BY id",
        (user_id,),
    ).fetchall()
    db.execute(
        "UPDATE users SET two_factor_recovery_hashes = ?, two_factor_updated_at = datetime('now') WHERE id = ?",
        (json.dumps([row["code_hash"] for row in rows]), user_id),
    )


def consume_recovery_code(db, user_id: int, code: str) -> bool:
    # Acquire a SQLite write lock for this user's recovery-code state before
    # reading active hashes, so parallel requests cannot both consume the same code.
    db.execute("UPDATE users SET two_factor_updated_at = two_factor_updated_at WHERE id = ?", (user_id,))
    _ensure_recovery_code_rows(db, user_id)
    rows = db.execute(
        "SELECT id, code_hash FROM two_factor_recovery_codes WHERE user_id = ? AND consumed_at IS NULL ORDER BY id",
        (user_id,),
    ).fetchall()
    clean = (code or "").strip()
    for row in rows:
        if bcrypt_check(clean, row["code_hash"]):
            cur = db.execute(
                "UPDATE two_factor_recovery_codes SET consumed_at = datetime('now') WHERE id = ? AND consumed_at IS NULL",
                (row["id"],),
            )
            if cur.rowcount != 1:
                return False
            _sync_legacy_recovery_hashes(db, user_id)
            log_audit(db, "two_factor_recovery_code_used", user_id=user_id)
            return True
    return False


def create_challenge(db, user_id: int, ip_address: Optional[str] = None, user_agent: Optional[str] = None) -> dict:
    token = secrets.token_urlsafe(32)
    methods = available_methods(db, user_id)
    expires_at = utc_ts() + CHALLENGE_TTL_SECONDS
    email_code = None
    email_hash = None
    email_expires = None
    if "email" in methods:
        email_code = f"{secrets.randbelow(1_000_000):06d}"
        email_hash = bcrypt_hash(email_code)
        email_expires = utc_ts() + EMAIL_CODE_TTL_SECONDS
    if email_code:
        user = db.execute("SELECT email, display_name, username, language FROM users WHERE id = ?", (user_id,)).fetchone()
        if not user or not user["email"]:
            methods = [m for m in methods if m != "email"]
            email_code = None
            email_hash = None
            email_expires = None
        else:
            # Fail closed: do not create a challenge that advertises e-mail if delivery failed.
            subject, text, html = two_factor_code_email(
                display_name=user["display_name"] or "",
                username=user["username"] or "",
                code=email_code,
                purpose="login",
                expires_minutes=10,
                language=user['language'] or 'de',
            )
            send_email(to=user["email"], subject=subject, text=text, html=html)
            log_audit(db, "two_factor_email_code_sent", user_id=user_id, ip_address=ip_address)
    db.execute(
        """INSERT INTO two_factor_challenges
           (user_id, token_hash, methods, expires_at, email_code_hash, email_code_expires_at, ip_address, user_agent, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))""",
        (user_id, sha256_hex(token), json.dumps(methods), expires_at, email_hash, email_expires, ip_address, (user_agent or "")[:255]),
    )
    log_audit(db, "two_factor_challenge_created", user_id=user_id, ip_address=ip_address, details=f"methods={','.join(methods)}")
    return {"challenge_token": token, "methods": methods, "expires_in": CHALLENGE_TTL_SECONDS}


def get_valid_challenge(db, token: str):
    if not token:
        return None
    row = db.execute(
        "SELECT * FROM two_factor_challenges WHERE token_hash = ? AND consumed_at IS NULL",
        (sha256_hex(token),),
    ).fetchone()
    if not row or int(row["expires_at"]) < utc_ts():
        return None
    if row["locked_until"] and int(row["locked_until"]) > utc_ts():
        return None
    return row


def record_challenge_failure(db, challenge_id: int) -> None:
    row = db.execute("SELECT attempts FROM two_factor_challenges WHERE id = ?", (challenge_id,)).fetchone()
    attempts = int(row["attempts"] or 0) + 1 if row else 1
    locked_until = utc_ts() + CHALLENGE_TTL_SECONDS if attempts >= 5 else None
    db.execute("UPDATE two_factor_challenges SET attempts = ?, locked_until = ? WHERE id = ?", (attempts, locked_until, challenge_id))


def consume_totp_reauth_code(db, user_id: int, code: str) -> bool:
    row = db.execute("SELECT two_factor_totp_secret FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row or not row["two_factor_totp_secret"]:
        return False
    counter = matching_totp_counter(row["two_factor_totp_secret"], code)
    if counter is None:
        return False
    try:
        db.execute(
            "INSERT INTO two_factor_totp_reauth_uses (user_id, timestep, created_at) VALUES (?, ?, datetime('now'))",
            (user_id, counter),
        )
    except Exception:
        return False
    return True


def verify_challenge_method(db, challenge, method: str, code: str) -> bool:
    user_id = challenge["user_id"]
    methods = json.loads(challenge["methods"] or "[]")
    if method not in methods:
        return False
    if method == "totp":
        row = db.execute("SELECT two_factor_totp_secret FROM users WHERE id = ?", (user_id,)).fetchone()
        return bool(row and row["two_factor_totp_secret"] and verify_totp(row["two_factor_totp_secret"], code))
    if method == "email":
        return bool(challenge["email_code_hash"] and int(challenge["email_code_expires_at"] or 0) >= utc_ts() and bcrypt_check(code or "", challenge["email_code_hash"]))
    if method == "recovery_code":
        return consume_recovery_code(db, user_id, code)
    return False


def mark_challenge_consumed(db, challenge_id: int) -> bool:
    cur = db.execute(
        "UPDATE two_factor_challenges SET consumed_at = datetime('now') WHERE id = ? AND consumed_at IS NULL",
        (challenge_id,),
    )
    return cur.rowcount == 1


def create_trusted_device(db, user_id: int, user_agent: str = "", return_id: bool = False):
    token = secrets.token_urlsafe(32)
    prefix = token[:12]
    expires = utc_ts() + REMEMBER_DEVICE_DAYS * 86400
    state = user_mfa_state(db, user_id)
    cur = db.execute(
        """INSERT INTO trusted_devices (user_id, token_hash, token_prefix, remember_version, user_agent, expires_at, created_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))""",
        (user_id, bcrypt_hash(token), prefix, state.get("remember_version", 1), (user_agent or "")[:255], expires),
    )
    log_audit(db, "two_factor_device_remembered", user_id=user_id)
    return (token, cur.lastrowid) if return_id else token


def get_valid_trusted_device_id(db, user_id: int, token: Optional[str]) -> Optional[tuple[int, str]]:
    """Return the trusted-device id and token prefix when a remember cookie is valid."""
    if not token:
        return None
    prefix = token[:12]
    rows = db.execute(
        "SELECT id, token_hash, remember_version, expires_at FROM trusted_devices WHERE user_id = ? AND token_prefix = ? AND revoked_at IS NULL",
        (user_id, prefix),
    ).fetchall()
    state = user_mfa_state(db, user_id)
    for row in rows:
        if int(row["expires_at"]) >= utc_ts() and row["remember_version"] == state.get("remember_version", 1) and bcrypt_check(token, row["token_hash"]):
            db.execute("UPDATE trusted_devices SET last_used_at = datetime('now') WHERE id = ?", (row["id"],))
            return (row["id"], prefix)
    return None


def trusted_device_valid(db, user_id: int, token: Optional[str]) -> bool:
    return get_valid_trusted_device_id(db, user_id, token) is not None


def trusted_device_is_current(row, token: Optional[str]) -> bool:
    if not token or not row["token_prefix"] or token[:12] != row["token_prefix"]:
        return False
    return bcrypt_check(token, row["token_hash"])


def list_user_device_sessions(db, user_id: int, *, current_session_id: Optional[str] = None, current_trusted_token: Optional[str] = None) -> list[dict]:
    state = user_mfa_state(db, user_id)
    rows = db.execute(
        """SELECT s.id, s.trusted_device_id, s.user_agent, s.ip_address, s.created_at, s.last_used_at,
                  datetime(s.expires_at, 'unixepoch') AS expires_at,
                  td.token_hash, td.token_prefix, td.remember_version, td.revoked_at AS trusted_revoked_at, td.expires_at AS trusted_expires_at
           FROM user_sessions s
           LEFT JOIN trusted_devices td ON td.id = s.trusted_device_id
           WHERE s.user_id = ? AND s.revoked_at IS NULL AND s.expires_at >= ?
           ORDER BY COALESCE(s.last_used_at, s.created_at) DESC""",
        (user_id, utc_ts()),
    ).fetchall()
    result = []
    remember_version = state.get("remember_version", 1)
    for row in rows:
        trusted_active = bool(
            row["trusted_device_id"]
            and row["trusted_revoked_at"] is None
            and int(row["trusted_expires_at"] or 0) >= utc_ts()
            and row["remember_version"] == remember_version
        )
        result.append({
            "id": row["id"],
            "trusted_device_id": row["trusted_device_id"],
            "trusted": trusted_active,
            "user_agent": row["user_agent"] or "",
            "ip_address": row["ip_address"] or "",
            "created_at": row["created_at"],
            "last_used_at": row["last_used_at"],
            "expires_at": row["expires_at"],
            "current_device": bool(current_session_id and row["id"] == current_session_id),
            "current_trusted_device": trusted_active and trusted_device_is_current(row, current_trusted_token),
        })
    return result


def revoke_device_session(db, user_id: int, session_id: str) -> Optional[dict]:
    row = db.execute(
        """SELECT s.id, s.trusted_device_id, td.token_hash, td.token_prefix
           FROM user_sessions s
           LEFT JOIN trusted_devices td ON td.id = s.trusted_device_id
           WHERE s.id = ? AND s.user_id = ?""",
        (session_id, user_id),
    ).fetchone()
    if not row:
        return None
    cur = db.execute(
        "UPDATE user_sessions SET revoked_at = datetime('now') WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
        (session_id, user_id),
    )
    if cur.rowcount != 1:
        return None
    if row["trusted_device_id"]:
        db.execute("UPDATE trusted_devices SET revoked_at = datetime('now') WHERE id = ? AND user_id = ? AND revoked_at IS NULL", (row["trusted_device_id"], user_id))
    return dict(row)


def revoke_trusted_devices(db, user_id: int) -> None:
    db.execute("UPDATE trusted_devices SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL", (user_id,))
    db.execute("UPDATE users SET two_factor_remember_version = COALESCE(two_factor_remember_version, 1) + 1 WHERE id = ?", (user_id,))
    log_audit(db, "two_factor_trusted_devices_revoked", user_id=user_id)


def create_mfa_action_grant(db, user_id: int, ttl_seconds: int = 300) -> str:
    """Create a one-time grant for exactly one sensitive action after reauth."""
    grant = secrets.token_urlsafe(32)
    db.execute(
        """INSERT INTO two_factor_action_grants (user_id, grant_hash, expires_at, created_at)
           VALUES (?, ?, ?, datetime('now'))""",
        (user_id, sha256_hex(grant), utc_ts() + ttl_seconds),
    )
    return grant


def validate_mfa_action_grant(db, user_id: int, grant: Optional[str]) -> bool:
    """Return whether a fresh MFA action grant exists without consuming it."""
    if not grant:
        return False
    row = db.execute(
        """SELECT id FROM two_factor_action_grants
           WHERE user_id = ? AND grant_hash = ? AND consumed_at IS NULL AND expires_at >= ?
           LIMIT 1""",
        (user_id, sha256_hex(grant), utc_ts()),
    ).fetchone()
    return bool(row)


def consume_mfa_action_grant(db, user_id: int, grant: Optional[str]) -> bool:
    """Atomically consume a fresh MFA action grant."""
    if not grant:
        return False
    cur = db.execute(
        """UPDATE two_factor_action_grants
           SET consumed_at = datetime('now')
           WHERE id = (
             SELECT id FROM two_factor_action_grants
             WHERE user_id = ? AND grant_hash = ? AND consumed_at IS NULL AND expires_at >= ?
             LIMIT 1
           )""",
        (user_id, sha256_hex(grant), utc_ts()),
    )
    return cur.rowcount == 1
