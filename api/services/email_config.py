"""SMTP/email configuration helpers."""

import json
from typing import Any, Optional

from fastapi import HTTPException

from db import get_db
from services.instance_config import get_instance_config
from services.utils import validate_email

SMTP_SECURITY_MODES = {"none", "starttls", "tls"}

DEFAULT_EMAIL_CONFIG: dict[str, Any] = {
    "smtp_enabled": False,
    "smtp_host": "",
    "smtp_port": 587,
    "smtp_security": "starttls",
    "smtp_auth_enabled": False,
    "smtp_username": "",
    "smtp_password_secret": "",
    "mail_from_address": "",
    "mail_from_name": "nia-todo",
    "mail_reply_to": "",
    "password_link_ttl_hours": 24,
}

EMAIL_CONFIG_KEYS = tuple(DEFAULT_EMAIL_CONFIG.keys())
SECRET_KEYS = {"smtp_password_secret"}


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


def _parse_int(value: Any, *, field: str, min_value: int, max_value: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise HTTPException(400, f"{field} must be a number")
    if parsed < min_value or parsed > max_value:
        raise HTTPException(400, f"{field} must be between {min_value} and {max_value}")
    return parsed


def _parse_config_value(key: str, value: Optional[str]) -> Any:
    if value is None:
        return DEFAULT_EMAIL_CONFIG[key]
    if key in {"smtp_enabled", "smtp_auth_enabled"}:
        return _parse_bool(value, field=key)
    if key == "smtp_port":
        return _parse_int(value, field="SMTP-Port", min_value=1, max_value=65535)
    if key == "password_link_ttl_hours":
        return _parse_int(value, field="Link validity", min_value=1, max_value=168)
    return str(value or "").strip()


def get_email_config(*, include_secret: bool = False) -> dict[str, Any]:
    values = dict(DEFAULT_EMAIL_CONFIG)
    try:
        with get_db() as db:
            placeholders = ",".join("?" for _ in EMAIL_CONFIG_KEYS)
            rows = db.execute(
                f"SELECT key, value FROM app_config WHERE key IN ({placeholders})",
                EMAIL_CONFIG_KEYS,
            ).fetchall()
    except Exception:
        rows = []

    for row in rows:
        key = row["key"]
        try:
            values[key] = _parse_config_value(key, row["value"])
        except HTTPException:
            values[key] = DEFAULT_EMAIL_CONFIG[key]

    if not include_secret:
        values["smtp_password_configured"] = bool(values.get("smtp_password_secret"))
        values.pop("smtp_password_secret", None)
    return values


def _validate_email_or_empty(value: str, *, field: str) -> str:
    email = str(value or "").strip()
    if not email:
        return ""
    error = validate_email(email)
    if error:
        raise HTTPException(400, f"{field}: {error}")
    return email


def normalize_email_config_update(data: dict[str, Any], *, existing_secret: str = "") -> dict[str, Any]:
    smtp_enabled = _parse_bool(data.get("smtp_enabled", DEFAULT_EMAIL_CONFIG["smtp_enabled"]), field="SMTP aktiviert")
    smtp_auth_enabled = _parse_bool(data.get("smtp_auth_enabled", DEFAULT_EMAIL_CONFIG["smtp_auth_enabled"]), field="SMTP Auth aktiviert")
    smtp_host = str(data.get("smtp_host") or "").strip()
    smtp_port = _parse_int(data.get("smtp_port", 587), field="SMTP-Port", min_value=1, max_value=65535)
    smtp_security = str(data.get("smtp_security") or "starttls").strip().lower()
    if smtp_security not in SMTP_SECURITY_MODES:
        raise HTTPException(400, "SMTP security must be none, starttls or tls")

    smtp_username = str(data.get("smtp_username") or "").strip()
    raw_secret = data.get("smtp_password_secret", None)
    smtp_password_secret = existing_secret if raw_secret is None else str(raw_secret or "")

    from_address = _validate_email_or_empty(data.get("mail_from_address") or "", field="From-Adresse")
    reply_to = _validate_email_or_empty(data.get("mail_reply_to") or "", field="Reply-To")
    from_name = str(data.get("mail_from_name") or "nia-todo").strip() or "nia-todo"
    ttl = _parse_int(data.get("password_link_ttl_hours", 24), field="Link validity", min_value=1, max_value=168)

    if smtp_enabled:
        if not smtp_host:
            raise HTTPException(400, "SMTP host is required when email is enabled")
        if not from_address:
            raise HTTPException(400, "From address is required when email is enabled")
    if smtp_auth_enabled and not smtp_username:
        raise HTTPException(400, "SMTP username is required when auth is enabled")

    return {
        "smtp_enabled": smtp_enabled,
        "smtp_host": smtp_host,
        "smtp_port": smtp_port,
        "smtp_security": smtp_security,
        "smtp_auth_enabled": smtp_auth_enabled,
        "smtp_username": smtp_username,
        "smtp_password_secret": smtp_password_secret,
        "mail_from_address": from_address,
        "mail_from_name": from_name,
        "mail_reply_to": reply_to,
        "password_link_ttl_hours": ttl,
    }


def update_email_config(data: dict[str, Any], *, client_ip: Optional[str] = None) -> dict[str, Any]:
    existing = get_email_config(include_secret=True)
    normalized = normalize_email_config_update(data, existing_secret=existing.get("smtp_password_secret", ""))
    serialized = {
        "smtp_enabled": _serialize_bool(normalized["smtp_enabled"]),
        "smtp_host": normalized["smtp_host"],
        "smtp_port": str(normalized["smtp_port"]),
        "smtp_security": normalized["smtp_security"],
        "smtp_auth_enabled": _serialize_bool(normalized["smtp_auth_enabled"]),
        "smtp_username": normalized["smtp_username"],
        "smtp_password_secret": normalized["smtp_password_secret"],
        "mail_from_address": normalized["mail_from_address"],
        "mail_from_name": normalized["mail_from_name"],
        "mail_reply_to": normalized["mail_reply_to"],
        "password_link_ttl_hours": str(normalized["password_link_ttl_hours"]),
    }
    with get_db() as db:
        old_rows = db.execute(
            f"SELECT key, value FROM app_config WHERE key IN ({','.join('?' for _ in EMAIL_CONFIG_KEYS)})",
            EMAIL_CONFIG_KEYS,
        ).fetchall()
        old_values = {row["key"]: row["value"] for row in old_rows}
        changed_keys = [key for key, value in serialized.items() if old_values.get(key) != value]
        for key, value in serialized.items():
            db.execute(
                """INSERT INTO app_config (key, value, updated_at)
                   VALUES (?, ?, datetime('now'))
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')""",
                (key, value),
            )
        if changed_keys:
            safe_changed_keys = [key for key in changed_keys if key not in SECRET_KEYS]
            if "smtp_password_secret" in changed_keys:
                safe_changed_keys.append("smtp_password_secret_set")
            db.execute(
                "INSERT INTO app_config_audit (changed_keys, client_ip) VALUES (?, ?)",
                (json.dumps(safe_changed_keys, separators=(",", ":")), client_ip),
            )
        db.commit()
    return get_email_config()


def is_email_configured() -> bool:
    config = get_email_config(include_secret=True)
    return bool(config["smtp_enabled"] and config["smtp_host"] and config["mail_from_address"])


def can_send_email_links() -> bool:
    """Return true only when SMTP and a stable public URL are configured."""
    return bool(is_email_configured() and get_instance_config().get("public_base_url"))


def get_password_link_ttl_hours() -> int:
    return int(get_email_config().get("password_link_ttl_hours") or 24)
