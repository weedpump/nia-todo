"""DB-backed BrainDump AI/STT provider configuration."""

from __future__ import annotations

import json
from typing import Any, Optional
from urllib.parse import urlparse, urlunparse

from fastapi import HTTPException

from db import get_db
from services.instance_config import _normalize_http_url

BRAINDUMP_CONFIG_KEYS = (
    "braindump_openclaw_url",
    "braindump_openclaw_token",
    "braindump_openclaw_model",
    "braindump_openclaw_backend_model",
    "braindump_stt_provider",
    "braindump_stt_url",
    "braindump_stt_token",
    "braindump_stt_language",
    "braindump_stt_timeout_seconds",
)

DEFAULT_BRAINDUMP_CONFIG = {
    "openclaw_url": "http://127.0.0.1:18789",
    "openclaw_token": "",
    "openclaw_model": "openclaw/default",
    "openclaw_backend_model": "",
    "stt_provider": "whisper_cpp_remote",
    "stt_url": "http://127.0.0.1:8766/inference",
    "stt_token": "",
    "stt_language": "de",
    "stt_timeout_seconds": 60.0,
}

KEY_TO_FIELD = {
    "braindump_openclaw_url": "openclaw_url",
    "braindump_openclaw_token": "openclaw_token",
    "braindump_openclaw_model": "openclaw_model",
    "braindump_openclaw_backend_model": "openclaw_backend_model",
    "braindump_stt_provider": "stt_provider",
    "braindump_stt_url": "stt_url",
    "braindump_stt_token": "stt_token",
    "braindump_stt_language": "stt_language",
    "braindump_stt_timeout_seconds": "stt_timeout_seconds",
}

FIELD_TO_KEY = {field: key for key, field in KEY_TO_FIELD.items()}
SUPPORTED_STT_PROVIDERS = {"whisper_cpp_remote", "local_whisper_cpp"}


def _append_path(base_url: str, suffix: str) -> str:
    parsed = urlparse(base_url.rstrip("/"))
    path = parsed.path.rstrip("/") + suffix
    return urlunparse((parsed.scheme, parsed.netloc, path, "", "", ""))


def openclaw_chat_url(config: dict[str, Any]) -> str:
    return _append_path(str(config.get("openclaw_url") or DEFAULT_BRAINDUMP_CONFIG["openclaw_url"]), "/v1/chat/completions")


def openclaw_models_url(config: dict[str, Any]) -> str:
    return _append_path(str(config.get("openclaw_url") or DEFAULT_BRAINDUMP_CONFIG["openclaw_url"]), "/v1/models")


def _normalize_model_target(value: str) -> str:
    model = str(value or "").strip()
    if not model:
        return DEFAULT_BRAINDUMP_CONFIG["openclaw_model"]
    if any(ch.isspace() for ch in model) or len(model) > 120:
        raise HTTPException(400, "OpenClaw model target is invalid")
    return model


def _normalize_optional_model(value: str) -> str:
    model = str(value or "").strip()
    if not model:
        return ""
    if any(ch.isspace() for ch in model) or len(model) > 120:
        raise HTTPException(400, "OpenClaw backend model is invalid")
    return model


def _normalize_token(value: Optional[str]) -> str:
    token = str(value or "").strip()
    if len(token) > 4096:
        raise HTTPException(400, "Token is too long")
    return token


def _normalize_stt_provider(value: str) -> str:
    provider = str(value or DEFAULT_BRAINDUMP_CONFIG["stt_provider"]).strip().lower()
    if provider not in SUPPORTED_STT_PROVIDERS:
        raise HTTPException(400, f"Unsupported BrainDump STT provider: {provider}")
    return provider


def _normalize_language(value: str) -> str:
    language = str(value or "de").strip().lower()
    if not language or len(language) > 16:
        raise HTTPException(400, "STT language is invalid")
    return language


def _normalize_timeout(value: Any) -> float:
    try:
        timeout = float(value)
    except (TypeError, ValueError):
        raise HTTPException(400, "STT timeout must be a number")
    if timeout < 1 or timeout > 300:
        raise HTTPException(400, "STT timeout must be between 1 and 300 seconds")
    return timeout


def normalize_braindump_config(data: dict[str, Any], *, existing: dict[str, Any] | None = None) -> dict[str, Any]:
    current = {**DEFAULT_BRAINDUMP_CONFIG, **(existing or {})}
    normalized = {
        "openclaw_url": _normalize_http_url(data.get("openclaw_url", current["openclaw_url"]), field="OpenClaw URL"),
        "openclaw_token": current.get("openclaw_token") or "",
        "openclaw_model": _normalize_model_target(data.get("openclaw_model", current["openclaw_model"])),
        "openclaw_backend_model": _normalize_optional_model(data.get("openclaw_backend_model", current["openclaw_backend_model"])),
        "stt_provider": _normalize_stt_provider(data.get("stt_provider", current["stt_provider"])),
        "stt_url": _normalize_http_url(data.get("stt_url", current["stt_url"]), field="STT URL"),
        "stt_token": current.get("stt_token") or "",
        "stt_language": _normalize_language(data.get("stt_language", current["stt_language"])),
        "stt_timeout_seconds": _normalize_timeout(data.get("stt_timeout_seconds", current["stt_timeout_seconds"])),
    }
    if "openclaw_token_secret" in data and data.get("openclaw_token_secret") is not None:
        normalized["openclaw_token"] = _normalize_token(data.get("openclaw_token_secret"))
    if "stt_token_secret" in data and data.get("stt_token_secret") is not None:
        normalized["stt_token"] = _normalize_token(data.get("stt_token_secret"))
    return normalized


def _parse_value(field: str, value: str | None) -> Any:
    if value is None:
        return DEFAULT_BRAINDUMP_CONFIG[field]
    if field == "stt_timeout_seconds":
        return _normalize_timeout(value)
    if field in {"openclaw_url", "stt_url"}:
        return _normalize_http_url(value, field="OpenClaw URL" if field == "openclaw_url" else "STT URL")
    if field == "stt_provider":
        return _normalize_stt_provider(value)
    if field == "stt_language":
        return _normalize_language(value)
    if field == "openclaw_model":
        return _normalize_model_target(value)
    if field == "openclaw_backend_model":
        return _normalize_optional_model(value)
    if field in {"openclaw_token", "stt_token"}:
        return _normalize_token(value)
    return value


def get_braindump_config(*, include_secrets: bool = False) -> dict[str, Any]:
    values = dict(DEFAULT_BRAINDUMP_CONFIG)
    try:
        with get_db() as db:
            placeholders = ",".join("?" for _ in BRAINDUMP_CONFIG_KEYS)
            rows = db.execute(f"SELECT key, value FROM app_config WHERE key IN ({placeholders})", BRAINDUMP_CONFIG_KEYS).fetchall()
    except Exception:
        rows = []
    for row in rows:
        field = KEY_TO_FIELD.get(row["key"])
        if not field:
            continue
        try:
            values[field] = _parse_value(field, row["value"])
        except HTTPException:
            values[field] = DEFAULT_BRAINDUMP_CONFIG[field]
    if include_secrets:
        return values
    public = {key: value for key, value in values.items() if key not in {"openclaw_token", "stt_token"}}
    public["openclaw_token_configured"] = bool(values.get("openclaw_token"))
    public["stt_token_configured"] = bool(values.get("stt_token"))
    return public


def update_braindump_config(data: dict[str, Any], *, client_ip: Optional[str] = None) -> dict[str, Any]:
    existing = get_braindump_config(include_secrets=True)
    normalized = normalize_braindump_config(data, existing=existing)
    serialized = {FIELD_TO_KEY[key]: str(value) for key, value in normalized.items()}
    old_serialized = {FIELD_TO_KEY[key]: str(value) for key, value in existing.items()}
    changed = [key for key, value in serialized.items() if old_serialized.get(key) != value]
    public_changed = [key for key in changed if key not in {"braindump_openclaw_token", "braindump_stt_token"}]
    if "braindump_openclaw_token" in changed:
        public_changed.append("braindump_openclaw_token")
    if "braindump_stt_token" in changed:
        public_changed.append("braindump_stt_token")
    with get_db() as db:
        for key, value in serialized.items():
            db.execute(
                """INSERT INTO app_config (key, value, updated_at)
                   VALUES (?, ?, datetime('now'))
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')""",
                (key, value),
            )
        if changed:
            db.execute(
                "INSERT INTO app_config_audit (changed_keys, client_ip) VALUES (?, ?)",
                (json.dumps(public_changed, separators=(",", ":")), client_ip),
            )
        db.commit()
    return get_braindump_config(include_secrets=False)
