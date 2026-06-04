"""Backend-only operational counters for admin capacity stats.

This module intentionally stores only aggregated technical counts. It must not
store user ids, IP addresses, raw user agents, transcripts, todo titles, project
names, or other user-provided content.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
import os
import re
import subprocess
from typing import Any

from fastapi import Request

from db import DB_PATH, get_db
from services.client_info import CLIENT_INFO_HEADER

COUNTER_BUCKET_SIZE = "hour"
RETENTION_DAYS = 90

BRAINDUMP_ENDPOINTS: dict[str, tuple[str, str]] = {
    "GET /api/braindump/v2/access": ("braindump", "access_check"),
    "POST /api/braindump/v2/live/audio-segment/transcribe": ("stt", "live_audio_transcribe"),
    "POST /api/braindump/v2/live/text-segment/extract": ("llm", "live_text_extract"),
    "POST /api/braindump/v2/live/audio-segment": ("braindump", "live_audio_segment"),
    "POST /api/braindump/v2/todos": ("braindump", "confirmed_todos_request"),
    "POST /api/braindump/v2/sessions": ("braindump", "session_started"),
    "POST /api/braindump/v2/sessions/*/segments/text": ("braindump", "session_text_segment"),
    "POST /api/braindump/v2/sessions/*/finalize": ("braindump", "session_finalized"),
}

ACCESS_LOG_RE = re.compile(r'"(?P<method>[A-Z]+) (?P<path>[^ ?"]+)(?:\?[^ "]*)? HTTP/[0-9.]+" (?P<status>\d{3})')
SESSION_ID_RE = re.compile(r"/api/braindump/v2/sessions/[^/]+/")


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _hour_bucket(dt: datetime | None = None) -> str:
    value = dt or _now_utc()
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    value = value.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    return value.isoformat().replace("+00:00", "Z")


def _status_class(status_code: int | str | None) -> str:
    try:
        code = int(status_code or 0)
    except (TypeError, ValueError):
        return "any"
    if code <= 0:
        return "any"
    return f"{code // 100}xx"


def _clean_platform(value: str) -> str:
    value = str(value or "").strip().lower()
    if value in {"web", "pwa", "android", "ios", "windows", "macos", "linux", "desktop", "unknown"}:
        return value
    return "unknown"


def classify_platform_from_strings(client_info: str = "", user_agent: str = "") -> str:
    raw_client = str(client_info or "").lower()
    raw_ua = str(user_agent or "").lower()
    combined = f"{raw_client} {raw_ua}"
    if "platform=android" in raw_client or "android" in raw_client:
        return "android"
    if "platform=ios" in raw_client or "platform=ipados" in raw_client or "iphone" in raw_ua or "ipad" in raw_ua:
        return "ios"
    if "platform=windows" in raw_client or "windows" in raw_client:
        return "windows"
    if "platform=macos" in raw_client or "mac os" in raw_ua or "macintosh" in raw_ua:
        return "macos"
    if "platform=linux" in raw_client or "linux" in raw_ua:
        return "linux"
    if "display-mode=standalone" in raw_client or "pwa" in raw_client:
        return "pwa"
    if "nia-todo-client(" in combined or "tauri" in combined:
        return "desktop"
    if raw_ua:
        return "web"
    return "unknown"


def classify_platform_from_request(request: Request | None) -> str:
    if request is None:
        return "unknown"
    return classify_platform_from_strings(
        request.headers.get(CLIENT_INFO_HEADER, ""),
        request.headers.get("user-agent", ""),
    )


def normalize_endpoint(method: str, path: str) -> str | None:
    method = str(method or "").upper().strip()
    path = str(path or "").split("?", 1)[0]
    if path.startswith("/api/braindump/v2/sessions/"):
        path = SESSION_ID_RE.sub("/api/braindump/v2/sessions/*/", path)
    signature = f"{method} {path}"
    return signature if signature in BRAINDUMP_ENDPOINTS else None


def increment_ops_counter(category: str, key: str, *, platform: str = "unknown", status_code: int | str | None = None, count: int = 1, bucket_start: str | None = None) -> None:
    """Increment one aggregated operational counter.

    Best-effort by design: a stats failure must never break the user action.
    """
    try:
        amount = int(count)
        if amount <= 0:
            return
        with get_db() as db:
            db.execute(
                """INSERT INTO ops_counters (bucket_start, bucket_size, category, key, platform, status_class, count, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
                   ON CONFLICT(bucket_start, bucket_size, category, key, platform, status_class)
                   DO UPDATE SET count = count + excluded.count, updated_at = datetime('now')""",
                (
                    bucket_start or _hour_bucket(),
                    COUNTER_BUCKET_SIZE,
                    str(category or "unknown")[:40],
                    str(key or "unknown")[:80],
                    _clean_platform(platform),
                    _status_class(status_code),
                    amount,
                ),
            )
            cutoff = (_now_utc() - timedelta(days=RETENTION_DAYS)).replace(minute=0, second=0, microsecond=0).isoformat().replace("+00:00", "Z")
            db.execute("DELETE FROM ops_counters WHERE bucket_size = 'hour' AND bucket_start < ?", (cutoff,))
    except Exception:
        return


def increment_endpoint_counter(request: Request | None, method: str, path: str, *, status_code: int | str | None = None, count: int = 1) -> None:
    signature = normalize_endpoint(method, path)
    if not signature:
        return
    category, key = BRAINDUMP_ENDPOINTS[signature]
    # Keep BrainDump/STT/LLM counters deployment-level, not per-user/per-client.
    # Platform distribution is shown separately from active sessions.
    increment_ops_counter(category, key, platform="unknown", status_code=status_code, count=count)


def count_db_rows(db) -> dict[str, int]:
    tables = {
        "users": "users",
        "workspaces": "workspaces",
        "projects": "projects",
        "sections": "sections",
        "todos": "todos",
        "reminders": "reminders",
        "location_reminders": "location_reminders",
        "saved_places": "saved_places",
        "push_subscriptions": "push_subscriptions",
        "api_keys": "api_keys",
        "passkeys": "passkeys",
    }
    result: dict[str, int] = {}
    for key, table in tables.items():
        try:
            row = db.execute(f"SELECT COUNT(*) AS count FROM {table}").fetchone()
            result[key] = int(row["count"] or 0)
        except Exception:
            result[key] = 0
    try:
        row = db.execute("SELECT COUNT(*) AS count FROM user_sessions WHERE revoked_at IS NULL AND expires_at > CAST(strftime('%s','now') AS INTEGER)").fetchone()
        result["user_sessions"] = int(row["count"] or 0)
    except Exception:
        result["user_sessions"] = 0
    try:
        row = db.execute("SELECT COUNT(*) AS count FROM users WHERE COALESCE(braindump_enabled, 0) = 1").fetchone()
        result["braindump_enabled_users"] = int(row["count"] or 0)
    except Exception:
        result["braindump_enabled_users"] = 0
    try:
        row = db.execute("SELECT COALESCE(SUM(hits), 0) AS hits, COUNT(*) AS routes FROM braindump_route_learning").fetchone()
        result["braindump_learned_routes"] = int(row["routes"] or 0)
        result["braindump_route_hits"] = int(row["hits"] or 0)
    except Exception:
        result["braindump_learned_routes"] = 0
        result["braindump_route_hits"] = 0
    return result


def database_size() -> dict[str, int]:
    paths = [DB_PATH, DB_PATH.with_name(DB_PATH.name + "-wal"), DB_PATH.with_name(DB_PATH.name + "-shm")]
    sizes = {path.name: path.stat().st_size for path in paths if path.exists()}
    return {"bytes": sum(sizes.values()), "files": sizes}


def platform_distribution(db) -> dict[str, int]:
    counts: dict[str, int] = defaultdict(int)
    try:
        rows = db.execute("SELECT user_agent FROM user_sessions WHERE revoked_at IS NULL AND expires_at > CAST(strftime('%s','now') AS INTEGER)").fetchall()
    except Exception:
        rows = []
    for row in rows:
        counts[classify_platform_from_strings("", row["user_agent"] or "")] += 1
    return dict(sorted(counts.items()))


def ops_counter_summary(db, *, days: int = 30) -> dict[str, Any]:
    days = max(1, min(int(days or 30), 90))
    cutoff = (_now_utc() - timedelta(days=days)).replace(minute=0, second=0, microsecond=0).isoformat().replace("+00:00", "Z")
    rows = db.execute(
        """SELECT category, key, platform, status_class, SUM(count) AS count
           FROM ops_counters
           WHERE bucket_start >= ? AND bucket_size = 'hour'
           GROUP BY category, key, platform, status_class
           ORDER BY category, key, platform, status_class""",
        (cutoff,),
    ).fetchall()
    by_key: dict[str, int] = defaultdict(int)
    by_category: dict[str, int] = defaultdict(int)
    by_platform: dict[str, int] = defaultdict(int)
    by_status: dict[str, int] = defaultdict(int)
    detailed = []
    for row in rows:
        count = int(row["count"] or 0)
        key = row["key"]
        category = row["category"]
        platform = row["platform"]
        status = row["status_class"]
        by_key[key] += count
        by_category[category] += count
        by_platform[platform] += count
        by_status[status] += count
        detailed.append({"category": category, "key": key, "platform": platform, "status_class": status, "count": count})
    return {
        "days": days,
        "by_key": dict(sorted(by_key.items())),
        "by_category": dict(sorted(by_category.items())),
        "by_platform": dict(sorted(by_platform.items())),
        "by_status": dict(sorted(by_status.items())),
        "details": detailed,
    }


def technical_stats(days: int = 30) -> dict[str, Any]:
    with get_db() as db:
        return {
            "period_days": max(1, min(int(days or 30), 90)),
            "database": database_size(),
            "counts": count_db_rows(db),
            "platforms": platform_distribution(db),
            "ops": ops_counter_summary(db, days=days),
        }


def _journal_units() -> list[str]:
    configured = os.environ.get("NIA_TODO_JOURNAL_UNIT") or os.environ.get("NIA_TODO_SERVICE_UNIT")
    if configured:
        return [configured]
    db_name = os.environ.get("NIA_TODO_DB", "")
    if "dev" in db_name:
        return ["nia-todo-dev"]
    return ["nia-todo", "nia-todo-dev"]


def backfill_from_journal(days: int = 30) -> dict[str, Any]:
    """Import aggregated BrainDump counters from existing systemd access logs."""
    days = max(1, min(int(days or 30), 90))
    since = f"{days} days ago"
    imported = 0
    scanned = 0
    units_tried = []
    aggregate: dict[tuple[str, str, str, str, str], int] = defaultdict(int)
    for unit in _journal_units():
        units_tried.append(unit)
        try:
            proc = subprocess.run(
                ["journalctl", "-u", unit, "--since", since, "--no-pager", "-o", "short-iso"],
                check=False,
                capture_output=True,
                text=True,
                timeout=30,
            )
        except Exception:
            continue
        if proc.returncode != 0 and not proc.stdout:
            continue
        for line in proc.stdout.splitlines():
            match = ACCESS_LOG_RE.search(line)
            if not match:
                continue
            scanned += 1
            signature = normalize_endpoint(match.group("method"), match.group("path"))
            if not signature:
                continue
            category, key = BRAINDUMP_ENDPOINTS[signature]
            ts_text = line[:25].strip()
            try:
                parsed = datetime.fromisoformat(ts_text)
            except ValueError:
                parsed = _now_utc()
            bucket = _hour_bucket(parsed)
            aggregate[(bucket, category, key, "unknown", _status_class(match.group("status")))] += 1
    if aggregate:
        with get_db() as db:
            for (bucket, category, key, platform, status), count in aggregate.items():
                db.execute(
                    """INSERT INTO ops_counters (bucket_start, bucket_size, category, key, platform, status_class, count, updated_at)
                       VALUES (?, 'hour', ?, ?, ?, ?, ?, datetime('now'))
                       ON CONFLICT(bucket_start, bucket_size, category, key, platform, status_class)
                       DO UPDATE SET count = excluded.count, updated_at = datetime('now')""",
                    (bucket, category, key, platform, status, count),
                )
                imported += count
    return {"days": days, "units_tried": units_tried, "log_lines_scanned": scanned, "counter_rows": len(aggregate), "imported_count": imported}
