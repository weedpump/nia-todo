"""Generic OIDC Authorization Code + PKCE helpers."""

from __future__ import annotations

import base64
import hashlib
import secrets
import time
import json
from urllib.parse import urlencode, urlsplit

import jwt as pyjwt
import requests
from fastapi import HTTPException

from db import get_db
from middleware.security import generate_csrf_token, set_csrf_cookie
from services.auth import create_admin_jwt_token, create_jwt_token
from services.audit import log_audit
from services.client_info import session_user_agent
from services.oidc_config import get_oidc_config, oidc_redirect_uri, require_secure_oidc_url
from rate_limit import get_client_ip

OIDC_STATE_TTL_SECONDS = 600


def sanitize_oidc_redirect_after(value: str | None) -> str:
    raw = str(value or "/").strip() or "/"
    if any(ord(ch) < 32 for ch in raw):
        return "/"
    parsed = urlsplit(raw)
    if parsed.scheme or parsed.netloc or not raw.startswith("/") or raw.startswith("//") or "\\" in raw:
        return "/"
    return raw


def cleanup_oidc_login_states() -> int:
    now = int(time.time())
    with get_db() as db:
        cursor = db.execute(
            """DELETE FROM oidc_login_states
               WHERE expires_at < ? OR consumed_at IS NOT NULL""",
            (now,),
        )
        state_rows = cursor.rowcount or 0
        handoff_rows = 0
        try:
            handoff_cursor = db.execute(
                """DELETE FROM oidc_native_handoffs
                   WHERE expires_at < ? OR consumed_at IS NOT NULL""",
                (now,),
            )
            handoff_rows = handoff_cursor.rowcount or 0
        except Exception:
            handoff_rows = 0
        db.commit()
        return state_rows + handoff_rows


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _pkce_challenge(verifier: str) -> str:
    return _b64url(hashlib.sha256(verifier.encode("ascii")).digest())


def _discovery_url(issuer: str) -> str:
    return f"{issuer.rstrip('/')}/.well-known/openid-configuration"


def discover_provider(config: dict | None = None) -> dict:
    config = config or get_oidc_config(include_secret=True)
    issuer = str(config.get("issuer_url") or "").rstrip("/")
    if not issuer:
        raise HTTPException(400, "OIDC issuer URL is not configured")
    try:
        response = requests.get(_discovery_url(issuer), timeout=8)
        response.raise_for_status()
        data = response.json()
    except Exception as exc:
        raise HTTPException(400, f"OIDC discovery failed: {exc}") from exc
    if str(data.get("issuer") or "").rstrip("/") != issuer:
        raise HTTPException(400, "OIDC discovery issuer does not match configured issuer")
    for key in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
        if not data.get(key):
            raise HTTPException(400, f"OIDC discovery missing {key}")
        require_secure_oidc_url(str(data[key]), field=f"OIDC discovery {key}")
    if data.get("userinfo_endpoint"):
        require_secure_oidc_url(str(data["userinfo_endpoint"]), field="OIDC discovery userinfo_endpoint")
    response_types = data.get("response_types_supported") or ["code"]
    if "code" not in response_types:
        raise HTTPException(400, "OIDC provider does not support Authorization Code flow")
    return data


OIDC_NATIVE_HANDOFF_TTL_SECONDS = 120


def create_native_handoff(*, kind: str, payload: dict, redirect_after: str = "/") -> str:
    if kind not in {"user", "error"}:
        raise HTTPException(400, "Invalid native OIDC handoff kind")
    safe_redirect_after = sanitize_oidc_redirect_after(redirect_after)
    code = secrets.token_urlsafe(32)
    with get_db() as db:
        db.execute(
            """INSERT INTO oidc_native_handoffs (code_hash, kind, payload_json, redirect_after, expires_at)
               VALUES (?, ?, ?, ?, ?)""",
            (_sha256_text(code), kind, json.dumps(payload, separators=(",", ":"), ensure_ascii=False), safe_redirect_after, int(time.time()) + OIDC_NATIVE_HANDOFF_TTL_SECONDS),
        )
        db.commit()
    return code


def consume_native_handoff(code: str) -> dict:
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            """SELECT * FROM oidc_native_handoffs
               WHERE code_hash = ? AND consumed_at IS NULL AND expires_at >= ?""",
            (_sha256_text(code or ""), int(time.time())),
        ).fetchone()
        if not row:
            raise HTTPException(400, "Native OIDC handoff is invalid or expired")
        cursor = db.execute(
            """UPDATE oidc_native_handoffs
               SET consumed_at = datetime('now'), payload_json = '{}'
               WHERE id = ? AND consumed_at IS NULL""",
            (row["id"],),
        )
        if cursor.rowcount != 1:
            raise HTTPException(400, "Native OIDC handoff is invalid or expired")
        db.commit()
    payload_json = row["payload_json"] or "{}"
    try:
        payload = json.loads(payload_json)
    except Exception as exc:
        raise HTTPException(400, "Native OIDC handoff payload is invalid") from exc
    return {"kind": row["kind"], "payload": payload, "redirect_after": row["redirect_after"] or "/"}


def create_authorization_url(*, purpose: str, redirect_after: str | None = None) -> str:
    config = get_oidc_config(include_secret=True)
    if not config.get("enabled"):
        raise HTTPException(400, "OIDC is not enabled")
    metadata = discover_provider(config)
    cleanup_oidc_login_states()
    safe_redirect_after = sanitize_oidc_redirect_after(redirect_after)
    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    verifier = _b64url(secrets.token_bytes(32))
    with get_db() as db:
        db.execute(
            """INSERT INTO oidc_login_states (state_hash, nonce, code_verifier, purpose, redirect_after, expires_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (_sha256_text(state), nonce, verifier, purpose, safe_redirect_after, int(time.time()) + OIDC_STATE_TTL_SECONDS),
        )
        db.commit()
    params = {
        "client_id": config["client_id"],
        "redirect_uri": oidc_redirect_uri(),
        "response_type": "code",
        "scope": config.get("scopes") or "openid email profile",
        "state": state,
        "nonce": nonce,
        "code_challenge": _pkce_challenge(verifier),
        "code_challenge_method": "S256",
    }
    return f"{metadata['authorization_endpoint']}?{urlencode(params)}"


def consume_state(state: str) -> dict:
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            """SELECT * FROM oidc_login_states
               WHERE state_hash = ? AND consumed_at IS NULL AND expires_at >= ?""",
            (_sha256_text(state or ""), int(time.time())),
        ).fetchone()
        if not row:
            raise HTTPException(400, "OIDC state is invalid or expired")
        cursor = db.execute(
            """UPDATE oidc_login_states
               SET consumed_at = datetime('now')
               WHERE id = ? AND consumed_at IS NULL""",
            (row["id"],),
        )
        if cursor.rowcount != 1:
            raise HTTPException(400, "OIDC state is invalid or expired")
        db.commit()
        return dict(row)


def exchange_code(code: str, state_row: dict, metadata: dict, config: dict) -> dict:
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": oidc_redirect_uri(),
        "client_id": config["client_id"],
        "code_verifier": state_row["code_verifier"],
    }
    auth = None
    if not config.get("public_client") and config.get("client_secret"):
        method = config.get("token_auth_method") or "auto"
        if method == "auto":
            supported = metadata.get("token_endpoint_auth_methods_supported") or []
            method = "client_secret_post" if "client_secret_basic" not in supported and "client_secret_post" in supported else "client_secret_basic"
        if method == "client_secret_post":
            data["client_secret"] = config["client_secret"]
        else:
            auth = (config["client_id"], config["client_secret"])
    try:
        response = requests.post(metadata["token_endpoint"], data=data, auth=auth, timeout=10)
        response.raise_for_status()
        tokens = response.json()
    except Exception as exc:
        raise HTTPException(400, f"OIDC token exchange failed: {exc}") from exc
    if not tokens.get("id_token"):
        raise HTTPException(400, "OIDC token response did not include an ID token")
    return tokens


def validate_id_token(id_token: str, metadata: dict, config: dict, nonce: str) -> dict:
    try:
        jwk_client = pyjwt.PyJWKClient(metadata["jwks_uri"])
        signing_key = jwk_client.get_signing_key_from_jwt(id_token)
        algorithms = [alg for alg in (metadata.get("id_token_signing_alg_values_supported") or ["RS256", "ES256"]) if alg != "none"]
        claims = pyjwt.decode(
            id_token,
            signing_key.key,
            algorithms=algorithms,
            audience=config["client_id"],
            issuer=config["issuer_url"].rstrip("/"),
            options={"require": ["exp", "iat", "iss", "aud", "sub"]},
        )
    except Exception as exc:
        raise HTTPException(400, f"OIDC ID token validation failed: {exc}") from exc
    aud = claims.get("aud")
    if claims.get("azp") and claims.get("azp") != config["client_id"]:
        raise HTTPException(400, "OIDC authorized party mismatch")
    if isinstance(aud, list) and len(aud) > 1 and claims.get("azp") != config["client_id"]:
        raise HTTPException(400, "OIDC authorized party mismatch")
    if claims.get("nonce") != nonce:
        raise HTTPException(400, "OIDC nonce mismatch")
    if not claims.get("sub"):
        raise HTTPException(400, "OIDC ID token missing subject")
    return claims


def enrich_claims_from_userinfo(claims: dict, tokens: dict, metadata: dict) -> dict:
    """Merge UserInfo claims when providers keep profile/email out of the ID token."""
    endpoint = metadata.get("userinfo_endpoint")
    access_token = tokens.get("access_token")
    if not endpoint or not access_token:
        return claims
    try:
        response = requests.get(endpoint, headers={"Authorization": f"Bearer {access_token}"}, timeout=8)
        response.raise_for_status()
        userinfo = response.json()
    except Exception:
        return claims
    userinfo_sub = userinfo.get("sub")
    if not userinfo_sub:
        raise HTTPException(400, "OIDC UserInfo missing subject")
    if userinfo_sub != claims.get("sub"):
        raise HTTPException(400, "OIDC UserInfo subject does not match ID token")
    id_email = str(claims.get("email") or "").strip().lower()
    userinfo_email = str(userinfo.get("email") or "").strip().lower()
    if id_email and userinfo_email and id_email != userinfo_email:
        raise HTTPException(400, "OIDC UserInfo email does not match ID token")
    merged = dict(claims)
    if userinfo_email and not id_email:
        merged["email"] = userinfo.get("email")
        # email_verified must come from the same source as the email claim.
        merged["email_verified"] = userinfo.get("email_verified") is True
    elif id_email and "email_verified" not in claims and userinfo_email and "email_verified" in userinfo:
        # Same subject and same email: UserInfo may fill the missing verification claim.
        merged["email_verified"] = userinfo.get("email_verified")
    for key, value in userinfo.items():
        if key in {"sub", "email", "email_verified"}:
            continue
        merged.setdefault(key, value)
    return merged


def _user_response(user, token: str, csrf_token: str) -> dict:
    return {
        "access_token": token,
        "token_type": "bearer",
        "csrf_token": csrf_token,
        "user": {
            "id": user["id"],
            "username": user["username"],
            "display_name": user["display_name"],
            "email": user["email"],
            "email_verified_at": user["email_verified_at"],
            "email_trust_source": user["email_trust_source"],
            "avatar_url": user["avatar_url"],
            "braindump_enabled": bool(user["braindump_enabled"]),
            "braindump_learning_enabled": bool(user["braindump_learning_enabled"]),
            "is_admin": bool(user["is_admin"]),
        },
    }


def complete_user_oidc_login(claims: dict, request, response) -> dict:
    email = str(claims.get("email") or "").strip().lower()
    if not email or claims.get("email_verified") is not True:
        raise HTTPException(403, "OIDC email must be verified")
    issuer = str(claims.get("iss") or "").rstrip("/")
    subject = str(claims.get("sub") or "")
    ip = get_client_ip(request) if request else None
    with get_db() as db:
        user = db.execute(
            """SELECT id, username, display_name, email, email_verified_at, email_trust_source, avatar_url, is_admin, token_version,
                      COALESCE(braindump_enabled, 0) AS braindump_enabled, COALESCE(braindump_learning_enabled, 1) AS braindump_learning_enabled
               FROM users WHERE lower(email) = lower(?) AND email_verified_at IS NOT NULL LIMIT 1""",
            (email,),
        ).fetchone()
        if not user:
            raise HTTPException(403, "No verified local user matches this OIDC email")
        existing = db.execute("SELECT user_id FROM user_oidc_identities WHERE issuer = ? AND subject = ?", (issuer, subject)).fetchone()
        if existing and existing["user_id"] != user["id"]:
            raise HTTPException(403, "This OIDC identity is linked to a different user")
        db.execute(
            """INSERT INTO user_oidc_identities (user_id, issuer, subject, email_at_link_time, last_login_at)
               VALUES (?, ?, ?, ?, datetime('now'))
               ON CONFLICT(issuer, subject) DO UPDATE SET email_at_link_time = excluded.email_at_link_time, last_login_at = datetime('now')""",
            (user["id"], issuer, subject, email),
        )
        # OIDC is a passwordless login assurance, equivalent to passwordless passkey login.
        # Login MFA is delegated to the identity provider; local sensitive-action gates still require
        # an explicit reauth ceremony because this does not mint an mfa_grant.
        token = create_jwt_token(dict(user), db, mfa_login_verified=True, create_session=True, user_agent=session_user_agent(request), ip_address=ip or "")
        csrf_token = generate_csrf_token()
        set_csrf_cookie(response, csrf_token)
        log_audit(db, "oidc_login_success", user_id=user["id"], ip_address=ip, details=f"issuer={issuer}")
        db.commit()
        return _user_response(user, token, csrf_token)


def complete_admin_oidc_login(claims: dict, response) -> dict:
    issuer = str(claims.get("iss") or "").rstrip("/")
    subject = str(claims.get("sub") or "")
    with get_db() as db:
        row = db.execute("SELECT id FROM admin_oidc_identities WHERE issuer = ? AND subject = ?", (issuer, subject)).fetchone()
        if not row:
            raise HTTPException(403, "OIDC identity is not linked to the admin account")
        db.execute("UPDATE admin_oidc_identities SET last_login_at = datetime('now') WHERE id = ?", (row["id"],))
        token = create_admin_jwt_token(db)
        csrf_token = generate_csrf_token()
        set_csrf_cookie(response, csrf_token)
        db.commit()
        return {"access_token": token, "token_type": "bearer", "admin": True, "csrf_token": csrf_token}


def link_admin_oidc_identity(claims: dict) -> dict:
    issuer = str(claims.get("iss") or "").rstrip("/")
    subject = str(claims.get("sub") or "")
    label = claims.get("email") or claims.get("preferred_username") or claims.get("name") or subject
    with get_db() as db:
        db.execute(
            """INSERT INTO admin_oidc_identities (issuer, subject, display_label)
               VALUES (?, ?, ?)
               ON CONFLICT(issuer, subject) DO UPDATE SET display_label = excluded.display_label""",
            (issuer, subject, str(label)[:255]),
        )
        db.commit()
    return {"linked": True, "issuer": issuer, "subject": subject, "display_label": str(label)}


def list_admin_oidc_identities() -> list[dict]:
    with get_db() as db:
        rows = db.execute(
            """SELECT id, issuer, subject, display_label, created_at, last_login_at
               FROM admin_oidc_identities
               ORDER BY created_at DESC, id DESC"""
        ).fetchall()
    return [dict(row) for row in rows]


def unlink_admin_oidc_identity(identity_id: int) -> dict:
    with get_db() as db:
        row = db.execute("SELECT id, issuer, subject FROM admin_oidc_identities WHERE id = ?", (identity_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Admin OIDC identity not found")
        db.execute("DELETE FROM admin_oidc_identities WHERE id = ?", (identity_id,))
        db.commit()
    return {"unlinked": True, "id": identity_id}
