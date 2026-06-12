"""Generic OIDC provider configuration."""

from __future__ import annotations

import json
from typing import Any, Optional
from urllib.parse import urlparse

from fastapi import HTTPException

from db import get_db
from services.instance_config import _normalize_http_url, get_instance_config

DEFAULT_OIDC_CONFIG: dict[str, Any] = {
    "enabled": False,
    "provider_name": "OIDC",
    "issuer_url": "",
    "client_id": "",
    "client_secret": "",
    "public_client": False,
    "token_auth_method": "auto",
    "scopes": "openid email profile",
}

FIELD_TO_KEY = {
    "enabled": "oidc_enabled",
    "provider_name": "oidc_provider_name",
    "issuer_url": "oidc_issuer_url",
    "client_id": "oidc_client_id",
    "client_secret": "oidc_client_secret",
    "public_client": "oidc_public_client",
    "token_auth_method": "oidc_token_auth_method",
    "scopes": "oidc_scopes",
}
KEY_TO_FIELD = {v: k for k, v in FIELD_TO_KEY.items()}
OIDC_CONFIG_KEYS = tuple(KEY_TO_FIELD.keys())
SECRET_FIELDS = {"client_secret"}
TOKEN_AUTH_METHODS = {"auto", "client_secret_basic", "client_secret_post"}


def _parse_bool(value: Any, *, field: str) -> bool:
    if isinstance(value, bool):
        return value
    raw = str(value or "").strip().lower()
    if raw in {"true", "1", "yes", "on"}:
        return True
    if raw in {"false", "0", "no", "off", ""}:
        return False
    raise HTTPException(400, f"{field} must be true or false")


def _serialize_bool(value: bool) -> str:
    return "true" if value else "false"


def _is_loopback_host(hostname: str | None) -> bool:
    host = (hostname or "").strip().lower()
    return host in {"localhost", "127.0.0.1", "::1"} or host.startswith("127.")


def require_secure_oidc_url(value: str, *, field: str, allow_empty: bool = False) -> str:
    raw = str(value or "").strip()
    if not raw:
        if allow_empty:
            return ""
        raise HTTPException(400, f"{field} is required")
    parsed = urlparse(raw)
    if parsed.scheme != "https" and not (parsed.scheme == "http" and _is_loopback_host(parsed.hostname)):
        raise HTTPException(400, f"{field} must use HTTPS unless it is loopback-only for development")
    return raw


def _normalize_issuer_url(value: str) -> str:
    url = _normalize_http_url(value, field="OIDC issuer URL", allow_empty=True)
    return require_secure_oidc_url(url, field="OIDC issuer URL", allow_empty=True).rstrip("/")


def _normalize_scopes(value: str) -> str:
    scopes = [item.strip() for item in str(value or "").replace(",", " ").split() if item.strip()]
    if "openid" not in scopes:
        scopes.insert(0, "openid")
    if "email" not in scopes:
        scopes.append("email")
    return " ".join(dict.fromkeys(scopes))


def _parse_config_value(key: str, value: Optional[str]) -> Any:
    field = KEY_TO_FIELD[key]
    if value is None:
        return DEFAULT_OIDC_CONFIG[field]
    if field in {"enabled", "public_client"}:
        return _parse_bool(value, field=field)
    if field == "issuer_url":
        return _normalize_issuer_url(value)
    if field == "scopes":
        return _normalize_scopes(value)
    if field == "token_auth_method":
        method = str(value or "auto").strip().lower()
        return method if method in TOKEN_AUTH_METHODS else "auto"
    return str(value or "").strip()


def get_oidc_config(*, include_secret: bool = False) -> dict[str, Any]:
    values = dict(DEFAULT_OIDC_CONFIG)
    try:
        with get_db() as db:
            placeholders = ",".join("?" for _ in OIDC_CONFIG_KEYS)
            rows = db.execute(f"SELECT key, value FROM app_config WHERE key IN ({placeholders})", OIDC_CONFIG_KEYS).fetchall()
    except Exception:
        rows = []
    for row in rows:
        try:
            values[KEY_TO_FIELD[row["key"]]] = _parse_config_value(row["key"], row["value"])
        except HTTPException:
            pass
    if not include_secret:
        values["client_secret_configured"] = bool(values.get("client_secret"))
        values.pop("client_secret", None)
    values["redirect_uri"] = oidc_redirect_uri()
    return values


def oidc_redirect_uri() -> str:
    base = str(get_instance_config().get("public_base_url") or "").strip()
    return f"{base.rstrip()}/api/oidc/callback" if base else "/api/oidc/callback"


def normalize_oidc_config_update(data: dict[str, Any], *, existing_secret: str = "") -> dict[str, Any]:
    enabled = _parse_bool(data.get("enabled", False), field="OIDC enabled")
    issuer_url = _normalize_issuer_url(data.get("issuer_url") or "")
    client_id = str(data.get("client_id") or "").strip()
    raw_secret = data.get("client_secret", None)
    client_secret = existing_secret if raw_secret is None else str(raw_secret or "").strip()
    public_client = _parse_bool(data.get("public_client", False), field="OIDC public client")
    provider_name = str(data.get("provider_name") or "OIDC").strip() or "OIDC"
    token_auth_method = str(data.get("token_auth_method") or "auto").strip().lower()
    if token_auth_method not in TOKEN_AUTH_METHODS:
        raise HTTPException(400, "OIDC token auth method must be auto, client_secret_basic, or client_secret_post")
    scopes = _normalize_scopes(data.get("scopes") or DEFAULT_OIDC_CONFIG["scopes"])

    if enabled:
        if not issuer_url:
            raise HTTPException(400, "OIDC issuer URL is required when OIDC is enabled")
        if not client_id:
            raise HTTPException(400, "OIDC client ID is required when OIDC is enabled")
        redirect_uri = oidc_redirect_uri()
        if not redirect_uri.startswith("http"):
            raise HTTPException(400, "Public base URL must be configured before enabling OIDC")
        require_secure_oidc_url(redirect_uri, field="OIDC redirect URI")
        if not public_client and not client_secret:
            raise HTTPException(400, "OIDC client secret is required unless public client is enabled")

    return {
        "enabled": enabled,
        "provider_name": provider_name,
        "issuer_url": issuer_url,
        "client_id": client_id,
        "client_secret": client_secret,
        "public_client": public_client,
        "token_auth_method": token_auth_method,
        "scopes": scopes,
    }


def update_oidc_config(data: dict[str, Any], *, client_ip: Optional[str] = None) -> dict[str, Any]:
    existing = get_oidc_config(include_secret=True)
    normalized = normalize_oidc_config_update(data, existing_secret=existing.get("client_secret", ""))
    serialized = {
        "oidc_enabled": _serialize_bool(normalized["enabled"]),
        "oidc_provider_name": normalized["provider_name"],
        "oidc_issuer_url": normalized["issuer_url"],
        "oidc_client_id": normalized["client_id"],
        "oidc_client_secret": normalized["client_secret"],
        "oidc_public_client": _serialize_bool(normalized["public_client"]),
        "oidc_token_auth_method": normalized["token_auth_method"],
        "oidc_scopes": normalized["scopes"],
    }
    with get_db() as db:
        old = {r["key"]: r["value"] for r in db.execute(
            f"SELECT key, value FROM app_config WHERE key IN ({','.join('?' for _ in OIDC_CONFIG_KEYS)})", OIDC_CONFIG_KEYS
        ).fetchall()}
        changed = [key for key, value in serialized.items() if old.get(key) != value]
        for key, value in serialized.items():
            db.execute("""INSERT INTO app_config (key, value, updated_at)
                          VALUES (?, ?, datetime('now'))
                          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')""", (key, value))
        if changed:
            safe = [key for key in changed if key != "oidc_client_secret"]
            if "oidc_client_secret" in changed:
                safe.append("oidc_client_secret_set")
            db.execute("INSERT INTO app_config_audit (changed_keys, client_ip) VALUES (?, ?)", (json.dumps(safe), client_ip))
        db.commit()
    return get_oidc_config()
