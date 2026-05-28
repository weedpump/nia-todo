"""nia-todo: Two-factor authentication endpoints."""

from typing import Optional
import base64
import json
import secrets
import time

from fastapi import APIRouter, Depends, Header, Request, Response
from pydantic import BaseModel

from db import get_db
from errors import api_error
from middleware.security import generate_csrf_token, set_csrf_cookie
from rate_limit import get_client_ip, require_login_rate_limit
from routers.auth import require_auth
from services.auth import create_jwt_token, decode_jwt_token, revoke_all_user_sessions, verify_user_credentials
from services.audit import log_audit
from services.client_info import session_user_agent
from services.webauthn import (
    b64url_decode, b64url_encode, cose_to_json, parse_auth_data,
    parse_none_attestation, relying_party_for_request, verify_assertion_signature,
    verify_client_data, passkeys_available_for_request,
)
from services.two_factor import (
    clear_recovery_codes, clear_recovery_codes_if_no_primary_factor,
    consume_mfa_action_grant, create_challenge, create_mfa_action_grant,
    create_recovery_codes, create_trusted_device, generate_totp_secret,
    get_two_factor_required, get_valid_challenge,
    list_user_device_sessions, mark_challenge_consumed, mfa_required_for_user, provisioning_uri,
    revoke_device_session, revoke_trusted_devices, set_two_factor_required, trusted_device_valid,
    user_mfa_state, validate_mfa_action_grant, verify_challenge_method, verify_totp, consume_totp_reauth_code, REAUTH_MAX_AGE_SECONDS,
    EMAIL_CODE_TTL_SECONDS, record_challenge_failure, sha256_hex, bcrypt_hash, utc_ts,
)
from services.email import send_email
from services.email_templates import two_factor_code_email

router = APIRouter(prefix="/api")


class VerifyChallengeRequest(BaseModel):
    challenge_token: str
    method: str
    code: str = ""
    remember_device: bool = False


class TotpConfirmRequest(BaseModel):
    secret: str
    code: str
    password: str = ""


class CodeRequest(BaseModel):
    code: str = ""


class ReauthRequest(BaseModel):
    code: str
    method: str = "totp"


class PasskeyNameRequest(BaseModel):
    name: str = "Passkey"


class PasskeyRegistrationVerifyRequest(BaseModel):
    name: str = "Passkey"
    challenge: str
    credential: dict
    password: str = ""


class PasskeyLoginOptionsRequest(BaseModel):
    challenge_token: str


class PasskeyLoginVerifyRequest(BaseModel):
    challenge_token: str
    credential: dict
    remember_device: bool = False


class PasswordlessPasskeyVerifyRequest(BaseModel):
    challenge: str
    credential: dict


class PasskeyReauthVerifyRequest(BaseModel):
    challenge: str
    credential: dict


def _current_payload(authorization: Optional[str], db, client_ip: Optional[str] = None) -> Optional[dict]:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    return decode_jwt_token(authorization[7:], db, client_ip=client_ip)


def require_enrollment_or_recent_mfa(request: Request, authorization: Optional[str] = Header(None)) -> int:
    with get_db() as db:
        payload = _current_payload(authorization, db, client_ip=get_client_ip(request))
        if not payload:
            raise api_error(401, "auth.notAuthenticated", "Not authenticated")
        user_id = payload.get("user_id")
        if payload.get("mfa_enroll_only"):
            return user_id
        if mfa_required_for_user(db, user_id) and not validate_mfa_action_grant(db, user_id, payload.get("mfa_grant")):
            raise api_error(403, "mfa.reauthRequired", "2FA re-authentication required")
        return user_id


def require_enrollment_or_mfa_action(request: Request, authorization: Optional[str] = Header(None)) -> int:
    with get_db() as db:
        payload = _current_payload(authorization, db, client_ip=get_client_ip(request))
        if not payload:
            raise api_error(401, "auth.notAuthenticated", "Not authenticated")
        user_id = payload.get("user_id")
        if payload.get("mfa_enroll_only"):
            return user_id
        if mfa_required_for_user(db, user_id):
            if not consume_mfa_action_grant(db, user_id, payload.get("mfa_grant")):
                raise api_error(403, "mfa.reauthRequired", "2FA re-authentication required")
            db.commit()
        return user_id


def require_2fa_status_auth(request: Request, authorization: Optional[str] = Header(None)) -> int:
    """Allow reading non-sensitive 2FA factor metadata with a valid interactive JWT.

    This endpoint intentionally does not require an MFA action grant: the frontend
    needs it to decide which reauth ceremony to start for sensitive actions.
    """
    payload = require_interactive_auth_payload(request, authorization)
    return payload.get("user_id")


def require_interactive_auth_payload(request: Request, authorization: Optional[str] = Header(None)) -> dict:
    """Require a valid interactive user JWT, but no fresh MFA action grant.

    This is for defensive account/session actions such as revoking remembered
    devices or sessions. It intentionally excludes API keys and enrollment-only
    tokens, but does not demand a new MFA ceremony.
    """
    with get_db() as db:
        payload = _current_payload(authorization, db, client_ip=get_client_ip(request))
        if not payload or payload.get("mfa_enroll_only"):
            raise api_error(401, "auth.notAuthenticated", "Not authenticated")
        return payload


def _reauth_bucket(db, user_id: int):
    # Include a per-user counter so a successful TOTP/e-mail/recovery reauth can
    # consume the current bucket and prevent one ceremony from minting multiple grants.
    now = int(time.time())
    row = db.execute(
        """SELECT * FROM two_factor_challenges
           WHERE user_id = ? AND reauth_counter IS NOT NULL AND consumed_at IS NULL AND expires_at >= ?
           ORDER BY reauth_counter DESC LIMIT 1""",
        (user_id, now),
    ).fetchone()
    if row:
        return row
    counter_row = db.execute(
        "SELECT COALESCE(MAX(reauth_counter), -1) + 1 AS counter FROM two_factor_challenges WHERE user_id = ? AND reauth_counter IS NOT NULL",
        (user_id,),
    ).fetchone()
    counter = int(counter_row["counter"] or 0) if counter_row else 0
    token_hash = sha256_hex(f"reauth:{user_id}:{int(now // REAUTH_MAX_AGE_SECONDS)}:{counter}")
    expires_at = now + REAUTH_MAX_AGE_SECONDS
    state = user_mfa_state(db, user_id)
    methods = ["totp"] if state.get("has_totp") else []
    if state.get("has_recovery_codes"):
        methods.append("recovery_code")
    if state.get("has_email_fallback") and not (state.get("has_totp") or state.get("has_passkey")):
        methods.append("email")
    db.execute(
        """INSERT INTO two_factor_challenges (user_id, token_hash, methods, expires_at, reauth_counter, created_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))""",
        (user_id, token_hash, json.dumps(methods), expires_at, counter),
    )
    return db.execute("SELECT * FROM two_factor_challenges WHERE token_hash = ?", (token_hash,)).fetchone()


def _send_reauth_email_code(db, user_id: int, bucket_id: int, ip_address: Optional[str] = None):
    user = db.execute("SELECT email, display_name, username, language FROM users WHERE id = ?", (user_id,)).fetchone()
    if not user or not user["email"]:
        raise api_error(400, "mfa.emailReauthUnavailable", "Email re-authentication is not available")
    email_code = f"{secrets.randbelow(1_000_000):06d}"
    subject, text, html = two_factor_code_email(
        display_name=user["display_name"] or "",
        username=user["username"] or "",
        code=email_code,
        purpose="reauth",
        expires_minutes=10,
        language=user['language'] or 'de',
    )
    send_email(to=user["email"], subject=subject, text=text, html=html)
    db.execute(
        "UPDATE two_factor_challenges SET email_code_hash = ?, email_code_expires_at = ? WHERE id = ?",
        (bcrypt_hash(email_code), int(time.time()) + EMAIL_CODE_TTL_SECONDS, bucket_id),
    )
    log_audit(db, "two_factor_reauth_email_code_sent", user_id=user_id, ip_address=ip_address)


def _get_valid_passkey_challenge(db, user_id: int, challenge: str, purpose: str):
    row = db.execute(
        "SELECT * FROM passkey_challenges WHERE user_id = ? AND challenge_hash = ? AND purpose = ? AND consumed_at IS NULL AND expires_at >= ?",
        (user_id, sha256_hex(challenge), purpose, int(time.time())),
    ).fetchone()
    if not row:
        return None
    if row["locked_until"] and int(row["locked_until"]) > int(time.time()):
        return None
    return row


def _record_passkey_challenge_failure(db, challenge_id: int) -> None:
    row = db.execute("SELECT attempts FROM passkey_challenges WHERE id = ?", (challenge_id,)).fetchone()
    attempts = int(row["attempts"] or 0) + 1 if row else 1
    locked_until = int(time.time()) + 300 if attempts >= 5 else None
    db.execute("UPDATE passkey_challenges SET attempts = ?, locked_until = ? WHERE id = ?", (attempts, locked_until, challenge_id))


def require_recent_mfa(request: Request, authorization: Optional[str] = Header(None)) -> int:
    with get_db() as db:
        payload = _current_payload(authorization, db, client_ip=get_client_ip(request))
        if not payload:
            raise api_error(401, "auth.notAuthenticated", "Not authenticated")
        user_id = payload.get("user_id")
        if not mfa_required_for_user(db, user_id):
            return user_id
        if not consume_mfa_action_grant(db, user_id, payload.get("mfa_grant")):
            raise api_error(403, "mfa.reauthRequired", "2FA re-authentication required")
        db.commit()
        return user_id


@router.post("/2fa/challenge/verify")
def verify_login_challenge(data: VerifyChallengeRequest, request: Request, response: Response):
    ip = get_client_ip(request)
    with get_db() as db:
        challenge = get_valid_challenge(db, data.challenge_token)
        if not challenge:
            raise api_error(401, "mfa.challengeInvalidOrExpired", "2FA challenge is invalid or expired")
        if not verify_challenge_method(db, challenge, data.method, data.code):
            record_challenge_failure(db, challenge["id"])
            log_audit(db, "two_factor_challenge_failed", user_id=challenge["user_id"], ip_address=ip, details=f"method={data.method}")
            db.commit()
            raise api_error(401, "mfa.codeInvalid", "Invalid 2FA code")
        if not mark_challenge_consumed(db, challenge["id"]):
            db.commit()
            raise api_error(401, "mfa.challengeAlreadyUsed", "2FA-Challenge bereits verwendet")
        user = db.execute(
            "SELECT id, username, display_name, email, email_verified_at, email_trust_source, avatar_url, is_admin, token_version FROM users WHERE id = ?",
            (challenge["user_id"],),
        ).fetchone()
        trusted_device_token = None
        trusted_device_id = None
        if data.remember_device:
            trusted_device_token, trusted_device_id = create_trusted_device(db, user["id"], session_user_agent(request), return_id=True)
            response.set_cookie("nia_2fa_device", trusted_device_token, max_age=30 * 86400, httponly=True, secure=request.url.scheme == "https", samesite="lax")
        token = create_jwt_token(dict(user), db, mfa_login_verified=True, create_session=True, trusted_device_id=trusted_device_id, user_agent=session_user_agent(request), ip_address=ip)
        csrf_token = generate_csrf_token()
        set_csrf_cookie(response, csrf_token)
        log_audit(db, "two_factor_challenge_passed", user_id=user["id"], ip_address=ip, details=f"method={data.method}; remember_device={bool(trusted_device_token)}")
        db.commit()
        return {
            "access_token": token,
            "token_type": "bearer",
            "csrf_token": csrf_token,
            "user": {
                "id": user["id"], "username": user["username"], "display_name": user["display_name"],
                "email": user["email"], "email_verified_at": user["email_verified_at"],
                "email_trust_source": user["email_trust_source"], "avatar_url": user["avatar_url"],
                "is_admin": bool(user["is_admin"]),
            },
        }


@router.get("/me/2fa")
def get_own_2fa(request: Request, user_id: int = Depends(require_2fa_status_auth)):
    with get_db() as db:
        state = user_mfa_state(db, user_id)
        state["passkey_setup_available"] = passkeys_available_for_request(request)
        return state


@router.get("/me/2fa/trusted-devices")
def list_trusted_devices(request: Request, payload: dict = Depends(require_interactive_auth_payload)):
    with get_db() as db:
        return {
            "trusted_devices": list_user_device_sessions(
                db,
                payload["user_id"],
                current_session_id=payload.get("sid"),
                current_trusted_token=request.cookies.get("nia_2fa_device"),
            )
        }


@router.delete("/me/2fa/trusted-devices")
def delete_all_trusted_devices(response: Response, payload: dict = Depends(require_interactive_auth_payload)):
    user_id = payload["user_id"]
    with get_db() as db:
        revoke_trusted_devices(db, user_id)
        revoke_all_user_sessions(db, user_id)
        log_audit(db, "user_sessions_revoked", user_id=user_id, details="scope=all")
        db.commit()
    response.delete_cookie("nia_2fa_device", httponly=True, samesite="lax")
    return {"revoked": True, "current_session": True}


@router.delete("/me/2fa/trusted-devices/{device_id}")
def delete_trusted_device(device_id: str, request: Request, response: Response, payload: dict = Depends(require_interactive_auth_payload)):
    user_id = payload["user_id"]
    current_session = payload.get("sid") == device_id
    with get_db() as db:
        row = revoke_device_session(db, user_id, device_id)
        if not row:
            raise api_error(404, "mfa.trustedDeviceNotFound", "Device session not found")
        current_trusted_device = bool(row.get("trusted_device_id")) and row.get("token_prefix") and request.cookies.get("nia_2fa_device", "")[:12] == row.get("token_prefix")
        log_audit(db, "user_session_revoked", user_id=user_id, details=f"session_id={device_id}; trusted_device_id={row.get('trusted_device_id')}; current_session={current_session}")
        db.commit()
    if current_session or current_trusted_device:
        response.delete_cookie("nia_2fa_device", httponly=True, samesite="lax")
    return {"revoked": True, "current_session": current_session}


@router.post("/me/2fa/totp/start")
def start_totp(user_id: int = Depends(require_enrollment_or_recent_mfa)):
    with get_db() as db:
        user = db.execute("SELECT username FROM users WHERE id = ?", (user_id,)).fetchone()
        secret = generate_totp_secret()
        return {"secret": secret, "otpauth_url": provisioning_uri(secret, user["username"])}


@router.post("/me/2fa/totp/confirm")
def confirm_totp(data: TotpConfirmRequest, request: Request, authorization: Optional[str] = Header(None), user_id: int = Depends(require_enrollment_or_mfa_action)):
    if not verify_totp(data.secret, data.code):
        raise api_error(400, "mfa.totpInvalid", "Invalid TOTP code")
    with get_db() as db:
        user = db.execute("SELECT username, email, password_hash FROM users WHERE id = ?", (user_id,)).fetchone()
        if not user or not data.password or not verify_user_credentials(db, user["username"], data.password):
            raise api_error(401, "mfa.passwordConfirmationRequired", "Password confirmation required")
        db.execute(
            "UPDATE users SET two_factor_enabled = 1, two_factor_totp_secret = ?, two_factor_updated_at = datetime('now') WHERE id = ?",
            (data.secret, user_id),
        )
        codes = create_recovery_codes(db, user_id)
        log_audit(db, "two_factor_totp_enabled", user_id=user_id)
        token_user = dict(db.execute("SELECT id, username, is_admin, token_version FROM users WHERE id = ?", (user_id,)).fetchone())
        payload = _current_payload(authorization, db, client_ip=get_client_ip(request)) or {}
        if payload.get("sid"):
            token_user["session_id"] = payload.get("sid")
        access_token = create_jwt_token(token_user, db, mfa_login_verified=True, create_session=not bool(payload.get("sid")), user_agent=session_user_agent(request), ip_address=get_client_ip(request))
        db.commit()
        return {"enabled": True, "recovery_codes": codes, "access_token": access_token, "token_type": "bearer"}


@router.delete("/me/2fa/totp")
def delete_totp(user_id: int = Depends(require_recent_mfa)):
    with get_db() as db:
        row = db.execute("SELECT two_factor_totp_secret FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row or not row["two_factor_totp_secret"]:
            raise api_error(404, "mfa.authenticatorNotConfigured", "Authenticator not configured")
        db.execute(
            """UPDATE users
               SET two_factor_totp_secret = NULL,
                   two_factor_updated_at = datetime('now')
               WHERE id = ?""",
            (user_id,),
        )
        recovery_cleared = clear_recovery_codes_if_no_primary_factor(db, user_id)
        log_audit(db, "two_factor_totp_removed", user_id=user_id, details=f"recovery_cleared={recovery_cleared}")
        db.commit()
        return {"removed": True}


@router.post("/me/2fa/disable")
def disable_2fa(_: CodeRequest, user_id: int = Depends(require_recent_mfa)):
    with get_db() as db:
        db.execute(
            """UPDATE users
               SET two_factor_enabled = 0, two_factor_totp_secret = NULL, two_factor_recovery_hashes = NULL,
                   two_factor_recovery_generated_at = NULL, two_factor_updated_at = datetime('now'),
                   two_factor_remember_version = COALESCE(two_factor_remember_version, 1) + 1
               WHERE id = ?""",
            (user_id,),
        )
        clear_recovery_codes(db, user_id)
        db.execute("UPDATE passkeys SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL", (user_id,))
        revoke_trusted_devices(db, user_id)
        log_audit(db, "two_factor_disabled", user_id=user_id)
        db.commit()
    return {"disabled": True}


@router.post("/me/2fa/recovery-codes/regenerate")
def regenerate_recovery_codes(user_id: int = Depends(require_recent_mfa)):
    with get_db() as db:
        state = user_mfa_state(db, user_id)
        if not (state.get("has_totp") or state.get("has_passkey")):
            raise api_error(400, "mfa.recoveryCodesNeedPrimaryFactor", "Recovery codes can only be generated with an active authenticator or passkey")
        codes = create_recovery_codes(db, user_id)
        db.commit()
        return {"recovery_codes": codes}


@router.post("/me/2fa/reauth/email/start")
def start_email_reauth(request: Request, authorization: Optional[str] = Header(None)):
    with get_db() as db:
        payload = _current_payload(authorization, db, client_ip=get_client_ip(request))
        if not payload:
            raise api_error(401, "auth.notAuthenticated", "Not authenticated")
        user_id = payload["user_id"]
        bucket = _reauth_bucket(db, user_id)
        methods = json.loads(bucket["methods"] or "[]")
        if "email" not in methods:
            raise api_error(400, "mfa.emailReauthUnavailable", "Email re-authentication is not available")
        if bucket["locked_until"] and int(bucket["locked_until"]) > int(time.time()):
            raise api_error(429, "mfa.tooManyReauthAttempts", "Too many re-auth attempts. Please try again later.")
        _send_reauth_email_code(db, user_id, bucket["id"], ip_address=get_client_ip(request))
        db.commit()
        return {"sent": True, "expires_in": EMAIL_CODE_TTL_SECONDS}


@router.post("/me/2fa/reauth")
def reauth(data: ReauthRequest, request: Request, authorization: Optional[str] = Header(None)):
    with get_db() as db:
        payload = _current_payload(authorization, db, client_ip=get_client_ip(request))
        if not payload:
            raise api_error(401, "auth.notAuthenticated", "Not authenticated")
        user_id = payload["user_id"]
        bucket = _reauth_bucket(db, user_id)
        if bucket["locked_until"] and int(bucket["locked_until"]) > int(time.time()):
            raise api_error(429, "mfa.tooManyReauthAttempts", "Too many re-auth attempts. Please try again later.")
        if data.method not in {"totp", "recovery_code", "email"}:
            valid = False
        elif data.method == "totp":
            valid = consume_totp_reauth_code(db, user_id, data.code)
        else:
            valid = verify_challenge_method(db, bucket, data.method, data.code)
        if not valid:
            record_challenge_failure(db, bucket["id"])
            log_audit(db, "two_factor_reauth_failed", user_id=user_id, details=f"method={data.method}")
            db.commit()
            raise api_error(401, "mfa.codeInvalid", "Invalid 2FA code")
        cur = db.execute(
            """UPDATE two_factor_challenges
               SET attempts = 0, locked_until = NULL, email_code_hash = NULL, email_code_expires_at = NULL,
                   consumed_at = datetime('now')
               WHERE id = ? AND consumed_at IS NULL""",
            (bucket["id"],),
        )
        if cur.rowcount != 1:
            db.commit()
            raise api_error(401, "mfa.reauthAlreadyUsed", "2FA re-authentication already used")
        user = db.execute("SELECT id, username, is_admin, token_version FROM users WHERE id = ?", (user_id,)).fetchone()
        token_user = dict(user)
        token_user["mfa_login_at"] = payload.get("mfa_login_at") or payload.get("mfa_at")
        token_user["session_id"] = payload.get("sid")
        token = create_jwt_token(token_user, db, mfa_grant=create_mfa_action_grant(db, user_id))
        log_audit(db, "two_factor_reauth_success", user_id=user_id)
        db.commit()
        return {"access_token": token, "token_type": "bearer"}


@router.post("/me/passkeys/options")
def passkey_registration_options(data: PasskeyNameRequest, request: Request, user_id: int = Depends(require_enrollment_or_recent_mfa)):
    challenge = secrets.token_urlsafe(32)
    rp = relying_party_for_request(request)
    with get_db() as db:
        db.execute(
            "INSERT INTO passkey_challenges (user_id, challenge_hash, purpose, expires_at) VALUES (?, ?, 'registration', ?)",
            (user_id, sha256_hex(challenge), int(time.time()) + 600),
        )
        user = db.execute("SELECT username, display_name FROM users WHERE id = ?", (user_id,)).fetchone()
        existing = db.execute("SELECT credential_id FROM passkeys WHERE user_id = ? AND revoked_at IS NULL", (user_id,)).fetchall()
        db.commit()
    return {
        "publicKey": {
            "challenge": b64url_encode(challenge.encode()),
            "rp": {"name": "nia-todo", "id": rp.rp_id},
            "user": {"id": b64url_encode(str(user_id).encode()), "name": user["username"], "displayName": user["display_name"] or user["username"]},
            "pubKeyCredParams": [{"type": "public-key", "alg": -7}],
            "authenticatorSelection": {"userVerification": "required", "residentKey": "required", "requireResidentKey": True},
            "timeout": 60000,
            "attestation": "none",
            "excludeCredentials": [{"type": "public-key", "id": r["credential_id"]} for r in existing],
        },
        "challenge": challenge,
        "name": data.name,
        "origin": rp.origin,
    }


@router.post("/me/passkeys/verify")
def passkey_registration_verify(data: PasskeyRegistrationVerifyRequest, request: Request, authorization: Optional[str] = Header(None), user_id: int = Depends(require_enrollment_or_mfa_action)):
    credential = data.credential or {}
    response = credential.get("response") or {}
    rp = relying_party_for_request(request)
    with get_db() as db:
        row = db.execute(
            "SELECT id FROM passkey_challenges WHERE user_id = ? AND challenge_hash = ? AND purpose = 'registration' AND consumed_at IS NULL AND expires_at >= ?",
            (user_id, sha256_hex(data.challenge), int(time.time())),
        ).fetchone()
        if not row:
            raise api_error(401, "passkey.challengeInvalidOrExpired", "Passkey challenge is invalid or expired")
        user = db.execute("SELECT username FROM users WHERE id = ?", (user_id,)).fetchone()
        if not user or not data.password or not verify_user_credentials(db, user["username"], data.password):
            raise api_error(401, "mfa.passwordConfirmationRequired", "Password confirmation required")
        try:
            client_data_json = b64url_decode(response.get("clientDataJSON", ""))
            attestation_object = b64url_decode(response.get("attestationObject", ""))
            verify_client_data(client_data_json, "webauthn.create", b64url_encode(data.challenge.encode()), rp.origin)
            attested = parse_none_attestation(attestation_object, rp.rp_id)
        except Exception:
            raise api_error(400, "passkey.registrationInvalid", "Invalid passkey registration")
        cur = db.execute(
            "UPDATE passkey_challenges SET consumed_at = datetime('now') WHERE id = ? AND consumed_at IS NULL",
            (row["id"],),
        )
        if cur.rowcount != 1:
            db.commit()
            raise api_error(401, "passkey.challengeAlreadyUsed", "Passkey challenge already used")
        credential_id = b64url_encode(attested.credential_id)
        db.execute(
            """INSERT INTO passkeys (user_id, credential_id, public_key, sign_count, name, transports, discoverable, created_at)
               VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'))""",
            (user_id, credential_id, cose_to_json(attested.cose_key), attested.sign_count, (data.name or "Passkey")[:80], json.dumps(credential.get("transports") or [])),
        )
        recovery_codes = []
        existing_recovery = db.execute("SELECT two_factor_recovery_hashes FROM users WHERE id = ?", (user_id,)).fetchone()
        try:
            existing_codes = json.loads(existing_recovery["two_factor_recovery_hashes"] or "[]") if existing_recovery else []
        except Exception:
            existing_codes = []
        if not existing_codes:
            recovery_codes = create_recovery_codes(db, user_id)
        db.execute("UPDATE users SET two_factor_enabled = 1, two_factor_updated_at = datetime('now') WHERE id = ?", (user_id,))
        log_audit(db, "passkey_added", user_id=user_id, details=f"credential_id={credential_id[:12]}")
        token_user = dict(db.execute("SELECT id, username, is_admin, token_version FROM users WHERE id = ?", (user_id,)).fetchone())
        payload = _current_payload(authorization, db, client_ip=get_client_ip(request)) or {}
        if payload.get("sid"):
            token_user["session_id"] = payload.get("sid")
        access_token = create_jwt_token(token_user, db, mfa_login_verified=True, create_session=not bool(payload.get("sid")), user_agent=session_user_agent(request), ip_address=get_client_ip(request))
        db.commit()
        return {"registered": True, "recovery_codes": recovery_codes, "access_token": access_token, "token_type": "bearer"}


@router.get("/me/passkeys")
def list_passkeys(user_id: int = Depends(require_auth)):
    with get_db() as db:
        rows = db.execute("SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC", (user_id,)).fetchall()
        return {"passkeys": [dict(r) for r in rows]}


@router.delete("/me/passkeys/{passkey_id}")
def delete_passkey(passkey_id: int, user_id: int = Depends(require_recent_mfa)):
    with get_db() as db:
        row = db.execute("SELECT id FROM passkeys WHERE id = ? AND user_id = ? AND revoked_at IS NULL", (passkey_id, user_id)).fetchone()
        if not row:
            raise api_error(404, "passkey.notFound", "Passkey not found")
        db.execute("UPDATE passkeys SET revoked_at = datetime('now') WHERE id = ?", (passkey_id,))
        recovery_cleared = clear_recovery_codes_if_no_primary_factor(db, user_id)
        log_audit(db, "passkey_removed", user_id=user_id, details=f"passkey_id={passkey_id}; recovery_cleared={recovery_cleared}")
        db.commit()
        return {"removed": passkey_id}


@router.post("/login/passkey/options")
def passwordless_passkey_login_options(request: Request, _: None = Depends(require_login_rate_limit)):
    challenge = secrets.token_urlsafe(32)
    now = int(time.time())
    rp = relying_party_for_request(request)
    with get_db() as db:
        db.execute("DELETE FROM passkey_login_challenges WHERE expires_at < ?", (now - 3600,))
        db.execute(
            "INSERT INTO passkey_login_challenges (challenge_hash, expires_at) VALUES (?, ?)",
            (sha256_hex(challenge), now + 300),
        )
        db.commit()
    return {
        "challenge": challenge,
        "publicKey": {
            "challenge": b64url_encode(challenge.encode()),
            "timeout": 60000,
            "userVerification": "required",
            "rpId": rp.rp_id,
        },
        "origin": rp.origin,
    }


@router.post("/login/passkey/verify")
def passwordless_passkey_login_verify(data: PasswordlessPasskeyVerifyRequest, request: Request, response: Response, _: None = Depends(require_login_rate_limit)):
    ip = get_client_ip(request)
    credential = data.credential or {}
    cred_id = credential.get("id") or credential.get("rawId")
    cred_response = credential.get("response") or {}
    with get_db() as db:
        challenge = db.execute(
            """SELECT * FROM passkey_login_challenges
               WHERE challenge_hash = ? AND consumed_at IS NULL AND expires_at >= ?""",
            (sha256_hex(data.challenge), int(time.time())),
        ).fetchone()
        if not challenge or (challenge["locked_until"] and int(challenge["locked_until"]) > int(time.time())):
            raise api_error(401, "passkey.challengeInvalidOrExpired", "Passkey challenge is invalid or expired")
        key = db.execute("SELECT * FROM passkeys WHERE credential_id = ? AND revoked_at IS NULL", (cred_id,)).fetchone()
        if not key or not int(key["discoverable"] or 0):
            db.execute("UPDATE passkey_login_challenges SET attempts = attempts + 1, locked_until = CASE WHEN attempts + 1 >= 5 THEN ? ELSE locked_until END WHERE id = ?", (int(time.time()) + 300, challenge["id"]))
            db.commit()
            raise api_error(401, "passkey.unknown", "Unknown passkey")
        try:
            client_data_json = b64url_decode(cred_response.get("clientDataJSON", ""))
            auth_data = b64url_decode(cred_response.get("authenticatorData", ""))
            signature = b64url_decode(cred_response.get("signature", ""))
            rp = relying_party_for_request(request)
            verify_client_data(client_data_json, "webauthn.get", b64url_encode(data.challenge.encode()), rp.origin)
            parsed = parse_auth_data(auth_data, rp.rp_id, require_attested=False, require_user_verified=True)
            user_handle = cred_response.get("userHandle")
            if not user_handle or user_handle != b64url_encode(str(key["user_id"]).encode()):
                raise ValueError("User handle mismatch")
            if int(key["sign_count"] or 0) > 0 and parsed["sign_count"] > 0 and parsed["sign_count"] <= int(key["sign_count"]):
                raise ValueError("Sign counter rollback")
            verify_assertion_signature(key["public_key"], auth_data, client_data_json, signature)
        except Exception:
            db.execute("UPDATE passkey_login_challenges SET attempts = attempts + 1, locked_until = CASE WHEN attempts + 1 >= 5 THEN ? ELSE locked_until END WHERE id = ?", (int(time.time()) + 300, challenge["id"]))
            log_audit(db, "login_failed", user_id=key["user_id"], ip_address=ip, details="method=passkey")
            db.commit()
            raise api_error(401, "passkey.verifyFailed", "Passkey verification failed")
        cur = db.execute("UPDATE passkey_login_challenges SET consumed_at = datetime('now') WHERE id = ? AND consumed_at IS NULL", (challenge["id"],))
        if cur.rowcount != 1:
            db.commit()
            raise api_error(401, "passkey.challengeAlreadyUsed", "Passkey challenge already used")
        db.execute("UPDATE passkeys SET last_used_at = datetime('now'), sign_count = MAX(sign_count, ?) WHERE id = ?", (parsed["sign_count"], key["id"]))
        user = db.execute("SELECT id, username, display_name, email, email_verified_at, email_trust_source, avatar_url, is_admin, token_version FROM users WHERE id = ?", (key["user_id"],)).fetchone()
        token = create_jwt_token(dict(user), db, mfa_login_verified=True, create_session=True, user_agent=session_user_agent(request), ip_address=ip)
        csrf_token = generate_csrf_token()
        set_csrf_cookie(response, csrf_token)
        log_audit(db, "login_success", user_id=user["id"], ip_address=ip, details="method=passkey")
        from rate_limit import rate_limiter
        rate_limiter.record_successful_login(ip)
        db.commit()
        return {"access_token": token, "token_type": "bearer", "csrf_token": csrf_token, "user": {"id": user["id"], "username": user["username"], "display_name": user["display_name"], "email": user["email"], "email_verified_at": user["email_verified_at"], "email_trust_source": user["email_trust_source"], "avatar_url": user["avatar_url"], "is_admin": bool(user["is_admin"])}}


@router.post("/2fa/passkey/options")
def passkey_login_options(data: PasskeyLoginOptionsRequest, request: Request):
    rp = relying_party_for_request(request)
    with get_db() as db:
        challenge = get_valid_challenge(db, data.challenge_token)
        if not challenge:
            raise api_error(401, "mfa.challengeInvalidOrExpired", "2FA challenge is invalid or expired")
        methods = json.loads(challenge["methods"] or "[]")
        if "passkey" not in methods:
            raise api_error(400, "passkey.notAvailableForChallenge", "Passkey not available for this challenge")
        rows = db.execute("SELECT credential_id FROM passkeys WHERE user_id = ? AND revoked_at IS NULL", (challenge["user_id"],)).fetchall()
        return {
            "publicKey": {
                "challenge": b64url_encode(data.challenge_token.encode()),
                "timeout": 60000,
                "userVerification": "required",
                "rpId": rp.rp_id,
                "allowCredentials": [{"type": "public-key", "id": row["credential_id"]} for row in rows],
            },
            "origin": rp.origin,
        }


@router.post("/2fa/passkey/verify")
def passkey_login_verify(data: PasskeyLoginVerifyRequest, request: Request, response: Response):
    ip = get_client_ip(request)
    credential = data.credential or {}
    cred_id = credential.get("id") or credential.get("rawId")
    cred_response = credential.get("response") or {}
    with get_db() as db:
        challenge = get_valid_challenge(db, data.challenge_token)
        if not challenge:
            raise api_error(401, "mfa.challengeInvalidOrExpired", "2FA challenge is invalid or expired")
        methods = json.loads(challenge["methods"] or "[]")
        if "passkey" not in methods:
            raise api_error(400, "passkey.notAvailableForChallenge", "Passkey not available for this challenge")
        key = db.execute("SELECT * FROM passkeys WHERE user_id = ? AND credential_id = ? AND revoked_at IS NULL", (challenge["user_id"], cred_id)).fetchone()
        if not key:
            record_challenge_failure(db, challenge["id"])
            db.commit()
            raise api_error(401, "passkey.unknown", "Unknown passkey")
        try:
            client_data_json = b64url_decode(cred_response.get("clientDataJSON", ""))
            auth_data = b64url_decode(cred_response.get("authenticatorData", ""))
            signature = b64url_decode(cred_response.get("signature", ""))
            rp = relying_party_for_request(request)
            verify_client_data(client_data_json, "webauthn.get", b64url_encode(data.challenge_token.encode()), rp.origin)
            parsed = parse_auth_data(auth_data, rp.rp_id, require_attested=False, require_user_verified=True)
            if int(key["sign_count"] or 0) > 0 and parsed["sign_count"] > 0 and parsed["sign_count"] <= int(key["sign_count"]):
                raise ValueError("Sign counter rollback")
            verify_assertion_signature(key["public_key"], auth_data, client_data_json, signature)
        except Exception:
            record_challenge_failure(db, challenge["id"])
            log_audit(db, "two_factor_challenge_failed", user_id=challenge["user_id"], ip_address=ip, details="method=passkey")
            db.commit()
            raise api_error(401, "passkey.verifyFailed", "Passkey verification failed")
        if not mark_challenge_consumed(db, challenge["id"]):
            db.commit()
            raise api_error(401, "mfa.challengeAlreadyUsed", "2FA-Challenge bereits verwendet")
        db.execute("UPDATE passkeys SET last_used_at = datetime('now'), sign_count = MAX(sign_count, ?) WHERE id = ?", (parsed["sign_count"], key["id"]))
        user = db.execute("SELECT id, username, display_name, email, email_verified_at, email_trust_source, avatar_url, is_admin, token_version FROM users WHERE id = ?", (challenge["user_id"],)).fetchone()
        trusted_device_token = None
        trusted_device_id = None
        if data.remember_device:
            trusted_device_token, trusted_device_id = create_trusted_device(db, user["id"], session_user_agent(request), return_id=True)
            response.set_cookie("nia_2fa_device", trusted_device_token, max_age=30 * 86400, httponly=True, secure=request.url.scheme == "https", samesite="lax")
        token = create_jwt_token(dict(user), db, mfa_login_verified=True, create_session=True, trusted_device_id=trusted_device_id, user_agent=session_user_agent(request), ip_address=ip)
        csrf_token = generate_csrf_token()
        set_csrf_cookie(response, csrf_token)
        log_audit(db, "two_factor_challenge_passed", user_id=user["id"], ip_address=ip, details=f"method=passkey; remember_device={bool(trusted_device_token)}")
        db.commit()
        return {"access_token": token, "token_type": "bearer", "csrf_token": csrf_token, "user": {"id": user["id"], "username": user["username"], "display_name": user["display_name"], "email": user["email"], "email_verified_at": user["email_verified_at"], "email_trust_source": user["email_trust_source"], "avatar_url": user["avatar_url"], "is_admin": bool(user["is_admin"])}}


@router.post("/me/2fa/reauth/passkey/options")
def passkey_reauth_options(request: Request, user_id: int = Depends(require_auth)):
    challenge = secrets.token_urlsafe(32)
    rp = relying_party_for_request(request)
    with get_db() as db:
        rows = db.execute("SELECT credential_id FROM passkeys WHERE user_id = ? AND revoked_at IS NULL", (user_id,)).fetchall()
        if not rows:
            raise api_error(400, "passkey.noneAvailable", "No passkey available")
        db.execute(
            "INSERT INTO passkey_challenges (user_id, challenge_hash, purpose, expires_at) VALUES (?, ?, 'authentication', ?)",
            (user_id, sha256_hex(challenge), int(time.time()) + 300),
        )
        db.commit()
    return {
        "challenge": challenge,
        "publicKey": {
            "challenge": b64url_encode(challenge.encode()),
            "timeout": 60000,
            "userVerification": "required",
            "rpId": rp.rp_id,
            "allowCredentials": [{"type": "public-key", "id": row["credential_id"]} for row in rows],
        },
        "origin": rp.origin,
    }


@router.post("/me/2fa/reauth/passkey/verify")
def passkey_reauth_verify(data: PasskeyReauthVerifyRequest, request: Request, authorization: Optional[str] = Header(None)):
    with get_db() as db:
        payload = _current_payload(authorization, db, client_ip=get_client_ip(request))
        if not payload:
            raise api_error(401, "auth.notAuthenticated", "Not authenticated")
        user_id = payload["user_id"]
        challenge = _get_valid_passkey_challenge(db, user_id, data.challenge, "authentication")
        if not challenge:
            raise api_error(401, "passkey.challengeInvalidOrExpired", "Passkey challenge is invalid or expired")
        credential = data.credential or {}
        cred_id = credential.get("id") or credential.get("rawId")
        key = db.execute("SELECT * FROM passkeys WHERE user_id = ? AND credential_id = ? AND revoked_at IS NULL", (user_id, cred_id)).fetchone()
        if not key:
            _record_passkey_challenge_failure(db, challenge["id"])
            db.commit()
            raise api_error(401, "passkey.unknown", "Unknown passkey")
        cred_response = credential.get("response") or {}
        try:
            client_data_json = b64url_decode(cred_response.get("clientDataJSON", ""))
            auth_data = b64url_decode(cred_response.get("authenticatorData", ""))
            signature = b64url_decode(cred_response.get("signature", ""))
            rp = relying_party_for_request(request)
            verify_client_data(client_data_json, "webauthn.get", b64url_encode(data.challenge.encode()), rp.origin)
            parsed = parse_auth_data(auth_data, rp.rp_id, require_attested=False, require_user_verified=True)
            if int(key["sign_count"] or 0) > 0 and parsed["sign_count"] > 0 and parsed["sign_count"] <= int(key["sign_count"]):
                raise ValueError("Sign counter rollback")
            verify_assertion_signature(key["public_key"], auth_data, client_data_json, signature)
        except Exception:
            _record_passkey_challenge_failure(db, challenge["id"])
            log_audit(db, "two_factor_reauth_failed", user_id=user_id, details="method=passkey")
            db.commit()
            raise api_error(401, "passkey.reauthFailed", "Passkey re-authentication failed")
        cur = db.execute(
            "UPDATE passkey_challenges SET consumed_at = datetime('now') WHERE id = ? AND consumed_at IS NULL",
            (challenge["id"],),
        )
        if cur.rowcount != 1:
            db.commit()
            raise api_error(401, "passkey.challengeAlreadyUsed", "Passkey challenge already used")
        db.execute("UPDATE passkeys SET last_used_at = datetime('now'), sign_count = MAX(sign_count, ?) WHERE id = ?", (parsed["sign_count"], key["id"]))
        user = db.execute("SELECT id, username, is_admin, token_version FROM users WHERE id = ?", (user_id,)).fetchone()
        token_user = dict(user)
        token_user["mfa_login_at"] = payload.get("mfa_login_at") or payload.get("mfa_at")
        token_user["session_id"] = payload.get("sid")
        token = create_jwt_token(token_user, db, mfa_grant=create_mfa_action_grant(db, user_id))
        log_audit(db, "two_factor_reauth_success", user_id=user_id, details="method=passkey")
        db.commit()
        return {"access_token": token, "token_type": "bearer"}


