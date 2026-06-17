"""Attachment policy and usage helpers."""

import json
import mimetypes
import sqlite3
from typing import Any

from fastapi import HTTPException

DEFAULT_ATTACHMENTS_ENABLED = True
DEFAULT_ALLOWED_ATTACHMENT_TYPES = [
    "image/*",
    "application/pdf",
    "text/plain",
    "text/markdown",
    "application/zip",
    "application/json",
]
DEFAULT_ATTACHMENT_QUOTA_BYTES = 5 * 1024 * 1024 * 1024
MAX_ATTACHMENT_QUOTA_BYTES = 1024 * 1024 * 1024 * 1024  # 1 TiB guardrail
BLOCKED_ATTACHMENT_CONTENT_TYPES = {
    "text/html",
    "image/svg+xml",
    "application/javascript",
    "text/javascript",
}

ATTACHMENT_CONFIG_KEYS = (
    "attachments_enabled",
    "attachments_allowed_types",
    "attachments_default_quota_bytes",
)


def _parse_bool(value: Any, default: bool = DEFAULT_ATTACHMENTS_ENABLED) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def normalize_allowed_attachment_types(value: Any) -> list[str]:
    if value is None:
        return list(DEFAULT_ALLOWED_ATTACHMENT_TYPES)
    if isinstance(value, str):
        raw_items = value.replace(",", "\n").splitlines()
    elif isinstance(value, list):
        raw_items = [str(item) for item in value]
    else:
        raise HTTPException(400, "Allowed attachment types must be a list or line-based string")
    items: list[str] = []
    seen = set()
    for raw in raw_items:
        item = str(raw or "").strip().lower()
        if not item:
            continue
        if item.startswith("."):
            if len(item) < 2 or any(ch in item for ch in "/\\\0\r\n "):
                raise HTTPException(400, f"Invalid attachment extension: {item}")
        elif item.endswith("/*"):
            prefix = item[:-2]
            if not prefix or "/" in prefix or any(ch in prefix for ch in "\\\0\r\n "):
                raise HTTPException(400, f"Invalid attachment type wildcard: {item}")
        elif "/" in item:
            major, minor = item.split("/", 1)
            if not major or not minor or any(ch in item for ch in "\\\0\r\n "):
                raise HTTPException(400, f"Invalid attachment MIME type: {item}")
        else:
            raise HTTPException(400, f"Invalid attachment type entry: {item}")
        if item not in seen:
            items.append(item)
            seen.add(item)
    if not items:
        raise HTTPException(400, "At least one allowed attachment type is required")
    return items


def normalize_quota_bytes(value: Any, *, allow_null: bool = False) -> int | None:
    if value is None or value == "":
        if allow_null:
            return None
        return DEFAULT_ATTACHMENT_QUOTA_BYTES
    try:
        quota = int(value)
    except (TypeError, ValueError):
        raise HTTPException(400, "Attachment quota must be a whole number of bytes")
    if quota < 0:
        raise HTTPException(400, "Attachment quota must not be negative")
    if quota > MAX_ATTACHMENT_QUOTA_BYTES:
        raise HTTPException(400, "Attachment quota is too large")
    return quota


def get_attachment_config(db) -> dict[str, Any]:
    values = {
        "enabled": DEFAULT_ATTACHMENTS_ENABLED,
        "allowed_types": list(DEFAULT_ALLOWED_ATTACHMENT_TYPES),
        "default_quota_bytes": DEFAULT_ATTACHMENT_QUOTA_BYTES,
    }
    try:
        rows = db.execute(
            "SELECT key, value FROM app_config WHERE key IN ('attachments_enabled', 'attachments_allowed_types', 'attachments_default_quota_bytes')"
        ).fetchall()
    except Exception:
        return values
    for row in rows:
        key = row["key"]
        raw = row["value"]
        try:
            if key == "attachments_enabled":
                values["enabled"] = _parse_bool(raw)
            elif key == "attachments_allowed_types":
                values["allowed_types"] = normalize_allowed_attachment_types(json.loads(raw or "[]"))
            elif key == "attachments_default_quota_bytes":
                values["default_quota_bytes"] = normalize_quota_bytes(raw)
        except Exception:
            continue
    return values


def update_attachment_config(db, data: dict[str, Any]) -> dict[str, Any]:
    current = get_attachment_config(db)
    enabled = _parse_bool(data.get("enabled", current["enabled"]))
    allowed_types = normalize_allowed_attachment_types(data.get("allowed_types", current["allowed_types"]))
    default_quota = normalize_quota_bytes(data.get("default_quota_bytes", current["default_quota_bytes"]))
    rows = {
        "attachments_enabled": "1" if enabled else "0",
        "attachments_allowed_types": json.dumps(allowed_types, separators=(",", ":")),
        "attachments_default_quota_bytes": str(default_quota),
    }
    for key, value in rows.items():
        db.execute(
            """INSERT INTO app_config (key, value, updated_at)
               VALUES (?, ?, datetime('now'))
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')""",
            (key, value),
        )
    return {"enabled": enabled, "allowed_types": allowed_types, "default_quota_bytes": default_quota}


def attachment_usage_bytes(db, user_id: int) -> int:
    try:
        row = db.execute("SELECT COALESCE(SUM(size_bytes), 0) AS total FROM todo_attachments WHERE user_id = ?", (user_id,)).fetchone()
    except Exception:
        return 0
    return int(row["total"] if row else 0)


def user_attachment_quota_bytes(db, user_id: int) -> int:
    try:
        row = db.execute("SELECT attachment_quota_bytes FROM users WHERE id = ?", (user_id,)).fetchone()
    except sqlite3.OperationalError:
        row = None
    if row and row["attachment_quota_bytes"] is not None:
        return int(row["attachment_quota_bytes"])
    return int(get_attachment_config(db)["default_quota_bytes"])


def attachment_usage_payload(db, user_id: int) -> dict[str, int | bool]:
    config = get_attachment_config(db)
    used = attachment_usage_bytes(db, user_id)
    quota = user_attachment_quota_bytes(db, user_id)
    return {
        "enabled": bool(config["enabled"]),
        "used_bytes": used,
        "quota_bytes": quota,
        "remaining_bytes": max(quota - used, 0),
    }


def _matches_allowed_type(filename: str, content_type: str, allowed_types: list[str]) -> bool:
    name = str(filename or "").lower()
    guessed_type = (mimetypes.guess_type(name)[0] or "").lower()
    candidate_types = {str(content_type or "").split(";", 1)[0].strip().lower(), guessed_type}
    candidate_types.discard("")
    if candidate_types & BLOCKED_ATTACHMENT_CONTENT_TYPES:
        return False
    for entry in allowed_types:
        if entry.startswith(".") and name.endswith(entry):
            return True
        if entry.endswith("/*"):
            prefix = entry[:-1]
            if any(candidate.startswith(prefix) for candidate in candidate_types):
                return True
        elif entry in candidate_types:
            return True
    return False


def enforce_attachment_upload_policy(db, *, user_id: int, filename: str, content_type: str, size_bytes: int) -> dict[str, Any]:
    config = get_attachment_config(db)
    if not config["enabled"]:
        raise HTTPException(403, "Attachments are disabled by the administrator")
    allowed_types = list(config["allowed_types"])
    if not _matches_allowed_type(filename, content_type, allowed_types):
        raise HTTPException(415, "This attachment file type is not allowed")
    used = attachment_usage_bytes(db, user_id)
    quota = user_attachment_quota_bytes(db, user_id)
    if used + int(size_bytes or 0) > quota:
        raise HTTPException(413, "Attachment quota exceeded")
    return {"used_bytes": used, "quota_bytes": quota, "allowed_types": allowed_types}
