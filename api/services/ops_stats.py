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
RETENTION_DAYS = 3650

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
KNOWN_CLIENT_INFO_KEYS = {"app", "mode", "runtime", "type", "platform", "display-mode", "display_mode", "version"}
KNOWN_CLIENT_MODES = {"native", "browser"}
KNOWN_CLIENT_PLATFORMS = {"android", "ios", "ipados", "windows", "macos", "linux", "browser", "web", "unknown"}
KNOWN_CLIENT_DISPLAY_MODES = {"standalone", "browser", "fullscreen", "minimal-ui"}
OS_LABELS = {
    "android": "Android",
    "ios": "iOS",
    "ipados": "iPadOS",
    "windows": "Windows",
    "macos": "macOS",
    "linux": "Linux",
}


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


def _client_info_from_user_agent(user_agent: str = "") -> dict[str, str]:
    """Extract only allowlisted client metadata from the marker.

    Values from headers/user-agents are untrusted and must never become free-text
    metric labels. Unknown enum values are normalized to safe buckets.
    """
    match = re.search(r"nia-todo-client\(([^)]{1,160})\)", str(user_agent or ""), re.IGNORECASE)
    if not match:
        return {}
    result: dict[str, str] = {}
    for part in match.group(1).split(";"):
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        key = key.strip().lower()
        value = value.strip().lower()[:80]
        if key not in KNOWN_CLIENT_INFO_KEYS or not value:
            continue
        if key in {"mode", "runtime", "type"}:
            result[key] = value if value in KNOWN_CLIENT_MODES else "unknown"
        elif key == "platform":
            result[key] = value if value in KNOWN_CLIENT_PLATFORMS else "unknown"
        elif key in {"display-mode", "display_mode"}:
            result[key] = value if value in KNOWN_CLIENT_DISPLAY_MODES else "unknown"
        elif key == "app":
            result[key] = "nia-todo" if value == "nia-todo" else "unknown"
        elif key == "version":
            # Version is accepted only as presence metadata; never used as a label.
            result[key] = "known"
    return result


def _strip_client_marker(user_agent: str = "") -> str:
    return re.sub(r"nia-todo-client\([^)]{1,160}\)\s*", "", str(user_agent or ""), flags=re.IGNORECASE).strip()


def classify_platform_from_strings(client_info: str = "", user_agent: str = "") -> str:
    embedded = _client_info_from_user_agent(user_agent)
    raw_client = " ".join([str(client_info or "").lower(), " ".join(f"{k}={v}" for k, v in embedded.items()).lower()]).strip()
    raw_ua = str(user_agent or "").lower()
    mode = str(embedded.get("mode") or embedded.get("runtime") or "")
    platform = str(embedded.get("platform") or "unknown")
    use_client_platform = mode == "native" and platform not in {"", "browser", "web", "unknown"}
    if use_client_platform and platform == "android":
        return "android"
    if use_client_platform and platform in {"ios", "ipados"}:
        return "ios"
    if use_client_platform and platform == "windows":
        return "windows"
    if use_client_platform and platform == "macos":
        return "macos"
    if use_client_platform and platform == "linux":
        return "linux"
    if "display-mode=standalone" in raw_client or "pwa" in raw_client:
        return "pwa"
    if "android" in raw_ua:
        return "android"
    if "iphone" in raw_ua or "ipad" in raw_ua:
        return "ios"
    if "windows" in raw_ua:
        return "windows"
    if "mac os" in raw_ua or "macintosh" in raw_ua:
        return "macos"
    if "linux" in raw_ua:
        return "linux"
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


def _increment_ops_counter_db(db, category: str, key: str, *, platform: str = "unknown", status_code: int | str | None = None, count: int = 1, bucket_start: str | None = None) -> None:
    amount = int(count)
    if amount <= 0:
        return
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


def increment_ops_counter(category: str, key: str, *, platform: str = "unknown", status_code: int | str | None = None, count: int = 1, bucket_start: str | None = None) -> None:
    """Increment one aggregated operational counter.

    Best-effort by design: a stats failure must never break the user action.
    """
    try:
        with get_db() as db:
            _increment_ops_counter_db(db, category, key, platform=platform, status_code=status_code, count=count, bucket_start=bucket_start)
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


def increment_duration_metric(category: str, key: str, duration_ms: float | int | None) -> None:
    """Store aggregate backend duration counters for capacity diagnostics."""
    try:
        ms = max(0, int(round(float(duration_ms or 0))))
    except (TypeError, ValueError):
        return
    increment_ops_counter(f"{category}_timing", f"{key}_timed_calls", count=1)
    increment_ops_counter(f"{category}_timing", f"{key}_ms_total", count=ms)


def increment_llm_usage_metrics(key: str, usage: dict[str, Any] | None) -> None:
    """Store aggregate LLM token usage when the provider reports it."""
    if not isinstance(usage, dict):
        return
    def int_value(name: str) -> int:
        try:
            return max(0, int(usage.get(name) or 0))
        except (TypeError, ValueError):
            return 0
    prompt = int_value("prompt_tokens")
    completion = int_value("completion_tokens")
    total = int_value("total_tokens") or prompt + completion
    details = usage.get("completion_tokens_details")
    reasoning = 0
    if isinstance(details, dict):
        try:
            reasoning = max(0, int(details.get("reasoning_tokens") or 0))
        except (TypeError, ValueError):
            reasoning = 0
    if prompt:
        increment_ops_counter("llm_tokens", f"{key}_prompt_tokens", count=prompt)
    if completion:
        increment_ops_counter("llm_tokens", f"{key}_completion_tokens", count=completion)
    if total:
        increment_ops_counter("llm_tokens", f"{key}_total_tokens", count=total)
    if reasoning:
        increment_ops_counter("llm_tokens", f"{key}_reasoning_tokens", count=reasoning)


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
        row = db.execute(
            """SELECT COUNT(DISTINCT s.user_id) AS count
               FROM user_sessions s
               JOIN users u ON u.id = s.user_id
               WHERE s.revoked_at IS NULL
                 AND s.expires_at > CAST(strftime('%s','now') AS INTEGER)
                 AND COALESCE(u.braindump_enabled, 0) = 1"""
        ).fetchone()
        result["active_braindump_enabled_users"] = int(row["count"] or 0)
    except Exception:
        result["active_braindump_enabled_users"] = 0
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


def _period_days(days: int) -> int:
    return max(1, min(int(days or 30), RETENTION_DAYS))


def _date_points(days: int) -> list[str]:
    days = _period_days(days)
    today = _now_utc().date()
    return [(today - timedelta(days=offset)).isoformat() for offset in range(days - 1, -1, -1)]


def _start_date(days: int) -> str:
    return (_now_utc().date() - timedelta(days=_period_days(days) - 1)).isoformat()


def _created_count(db, table: str, days: int) -> int:
    cutoff = _start_date(days)
    try:
        row = db.execute(f"SELECT COUNT(*) AS count FROM {table} WHERE date(created_at) >= date(?)", (cutoff,)).fetchone()
        return int(row["count"] or 0)
    except Exception:
        return 0


def _cumulative_created_series(db, table: str, *, days: int) -> list[dict[str, Any]]:
    points = _date_points(days)
    if not points:
        return []
    try:
        rows = db.execute(
            f"""SELECT date(created_at) AS day, COUNT(*) AS count
                FROM {table}
                WHERE created_at IS NOT NULL
                GROUP BY date(created_at)
                ORDER BY day"""
        ).fetchall()
    except Exception:
        rows = []
    created_by_day = {row["day"]: int(row["count"] or 0) for row in rows if row["day"]}
    cumulative_before = sum(count for day, count in created_by_day.items() if day < points[0])
    total = cumulative_before
    series = []
    for day in points:
        total += created_by_day.get(day, 0)
        series.append({"date": day, "value": total})
    return series


def _daily_ops_series(db, key: str, *, days: int) -> list[dict[str, Any]]:
    points = _date_points(days)
    values = {day: 0 for day in points}
    if not points:
        return []
    rows = db.execute(
        """SELECT substr(bucket_start, 1, 10) AS day, SUM(count) AS count
           FROM ops_counters
           WHERE bucket_size = 'hour' AND key = ? AND substr(bucket_start, 1, 10) >= ?
           GROUP BY day
           ORDER BY day""",
        (key, points[0]),
    ).fetchall()
    for row in rows:
        day = row["day"]
        if day in values:
            values[day] = int(row["count"] or 0)
    return [{"date": day, "value": values[day]} for day in points]


def inventory_summary(db, *, days: int = 30) -> dict[str, Any]:
    days = _period_days(days)
    current = count_db_rows(db)
    tracked = {
        "users": "users",
        "workspaces": "workspaces",
        "projects": "projects",
        "todos": "todos",
        "reminders": "reminders",
        "location_reminders": "location_reminders",
        "push_subscriptions": "push_subscriptions",
    }
    created = {key: _created_count(db, table, days) for key, table in tracked.items()}
    periods = {
        "7d": {key: _created_count(db, table, 7) for key, table in tracked.items()},
        "30d": {key: _created_count(db, table, 30) for key, table in tracked.items()},
        "365d": {key: _created_count(db, table, 365) for key, table in tracked.items()},
    }
    series = {
        "users": _cumulative_created_series(db, "users", days=days),
        "projects": _cumulative_created_series(db, "projects", days=days),
        "workspaces": _cumulative_created_series(db, "workspaces", days=days),
        "todos": _cumulative_created_series(db, "todos", days=days),
        "reminders": _cumulative_created_series(db, "reminders", days=days),
    }
    return {"days": days, "current": current, "created": created, "periods": periods, "series": series}


def _browser_name(user_agent: str = "") -> str:
    # Native apps include a WebView user-agent, but for product stats they are
    # apps, not browsers. Web/PWA sessions may still include X-Nia-Client.
    embedded = _client_info_from_user_agent(user_agent)
    mode = str(embedded.get("mode") or embedded.get("runtime") or "")
    if embedded and mode == "native":
        return ""
    ua = _strip_client_marker(user_agent)
    if not ua:
        return "unknown"
    ios_webkit = "iPhone" in ua or "iPad" in ua or "CriOS/" in ua or "EdgiOS/" in ua or "FxiOS/" in ua
    if ios_webkit:
        return "Safari/WebKit"
    if "EdgA/" in ua or "Edg/" in ua:
        return "Edge"
    if "SamsungBrowser/" in ua:
        return "Samsung Internet"
    if "OPR/" in ua or "Opera" in ua:
        return "Opera"
    if "Firefox/" in ua:
        return "Firefox"
    if "Chrome/" in ua:
        return "Chrome"
    if "Safari/" in ua:
        return "Safari"
    return "Other"


def _os_name(user_agent: str = "") -> str:
    embedded = _client_info_from_user_agent(user_agent)
    platform = str(embedded.get("platform") or "unknown")
    mode = str(embedded.get("mode") or embedded.get("runtime") or "")
    if platform in OS_LABELS and not (mode == "browser" or platform in {"browser", "web"}):
        return OS_LABELS[platform]
    ua = _strip_client_marker(user_agent).lower()
    if "android" in ua:
        return "Android"
    if "iphone" in ua:
        return "iOS"
    if "ipad" in ua:
        return "iPadOS"
    if "windows" in ua:
        return "Windows"
    if "mac os" in ua or "macintosh" in ua:
        return "macOS"
    if "linux" in ua:
        return "Linux"
    return "unknown"


def _app_type(user_agent: str = "") -> str:
    embedded = _client_info_from_user_agent(user_agent)
    platform = str(embedded.get("platform") or "unknown")
    mode = str(embedded.get("mode") or embedded.get("runtime") or embedded.get("type") or "")
    display_mode = str(embedded.get("display-mode") or embedded.get("display_mode") or "")
    ua = _strip_client_marker(user_agent)
    is_native = mode == "native"
    if display_mode == "standalone" or "pwa" in mode:
        return "PWA"
    if is_native and platform == "android":
        return "Android App"
    if is_native and platform in {"ios", "ipados"}:
        return "iOS App"
    if is_native and platform == "windows":
        return "Windows App"
    if is_native and platform == "macos":
        return "macOS App"
    if is_native and platform == "linux":
        return "Linux App"
    if is_native:
        return "Unbekannte App"
    if ua:
        return "Browser"
    return "unknown"


def _increment(counts: dict[str, int], key: str):
    counts[key or "unknown"] += 1


def _client_mix_key(kind: str, label: str) -> str:
    return f"client_{kind}:{str(label or 'unknown')[:60]}"


def _client_mix_label(key: str, kind: str) -> str:
    prefix = f"client_{kind}:"
    return key[len(prefix):] if key.startswith(prefix) else key


def record_client_session_metrics(db, user_agent: str = "", *, bucket_start: str | None = None) -> bool:
    """Record aggregated client mix.

    This intentionally stores no user id, IP, raw user-agent, or session id.
    All labels are derived from strict allowlists or fixed UA classifier buckets.
    """
    try:
        values = {
            "app_type": _app_type(user_agent),
            "os": _os_name(user_agent),
            "browser": _browser_name(user_agent),
            "platform": classify_platform_from_strings("", user_agent),
        }
        for kind, label in values.items():
            if not label:
                continue
            _increment_ops_counter_db(db, "client_mix", _client_mix_key(kind, label), count=1, bucket_start=bucket_start)
        return True
    except Exception:
        return False


def record_user_session_client_mix(db, session_id: str, user_agent: str = "") -> bool:
    """Count one user session once for the anonymized historical client mix."""
    if not session_id:
        return False
    try:
        row = db.execute("SELECT client_mix_counted_at FROM user_sessions WHERE id = ?", (session_id,)).fetchone()
        if not row or row["client_mix_counted_at"] is not None:
            return False
        if not record_client_session_metrics(db, user_agent):
            return False
        cur = db.execute(
            """UPDATE user_sessions
               SET client_mix_counted_at = datetime('now')
               WHERE id = ?
                 AND client_mix_counted_at IS NULL""",
            (session_id,),
        )
        return cur.rowcount == 1
    except Exception:
        return False


def _session_bucket_start(value: str | None) -> str:
    try:
        text = str(value or "").replace("Z", "+00:00")
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return _hour_bucket(parsed)
    except Exception:
        return _hour_bucket()


def backfill_existing_session_client_mix(db, *, batch_size: int = 500) -> int:
    """Count existing sessions once so users do not need to log in again."""
    counted = 0
    safe_batch_size = max(1, min(int(batch_size or 500), 5000))
    while True:
        try:
            rows = db.execute(
                """SELECT id, user_agent, created_at
                   FROM user_sessions
                   WHERE client_mix_counted_at IS NULL
                   ORDER BY created_at, id
                   LIMIT ?""",
                (safe_batch_size,),
            ).fetchall()
        except Exception:
            return counted
        if not rows:
            return counted
        batch_counted = 0
        for row in rows:
            session_id = row["id"]
            try:
                existing = db.execute("SELECT client_mix_counted_at FROM user_sessions WHERE id = ?", (session_id,)).fetchone()
                if not existing or existing["client_mix_counted_at"] is not None:
                    continue
                if not record_client_session_metrics(db, row["user_agent"] or "", bucket_start=_session_bucket_start(row["created_at"])):
                    continue
                cur = db.execute(
                    """UPDATE user_sessions
                       SET client_mix_counted_at = datetime('now')
                       WHERE id = ?
                         AND client_mix_counted_at IS NULL""",
                    (session_id,),
                )
                if cur.rowcount == 1:
                    counted += 1
                    batch_counted += 1
            except Exception:
                continue
        if batch_counted == 0:
            # Avoid a tight loop if all remaining rows fail unexpectedly.
            return counted


def _historical_client_mix(db, *, days: int) -> dict[str, dict[str, int]]:
    cutoff = _start_date(days)
    result = {"app_types": defaultdict(int), "operating_systems": defaultdict(int), "browsers": defaultdict(int), "platforms": defaultdict(int)}
    kind_map = {
        "app_type": "app_types",
        "os": "operating_systems",
        "browser": "browsers",
        "platform": "platforms",
    }
    rows = db.execute(
        """SELECT key, SUM(count) AS count
           FROM ops_counters
           WHERE category = 'client_mix'
             AND bucket_size = 'hour'
             AND substr(bucket_start, 1, 10) >= ?
           GROUP BY key""",
        (cutoff,),
    ).fetchall()
    for row in rows:
        key = row["key"]
        count = int(row["count"] or 0)
        for kind, bucket in kind_map.items():
            if str(key).startswith(f"client_{kind}:"):
                result[bucket][_client_mix_label(key, kind)] += count
                break
    return {bucket: dict(sorted(values.items())) for bucket, values in result.items()}


def platform_analysis(db, *, days: int = 30) -> dict[str, Any]:
    platforms: dict[str, int] = defaultdict(int)
    browsers: dict[str, int] = defaultdict(int)
    app_types: dict[str, int] = defaultdict(int)
    operating_systems: dict[str, int] = defaultdict(int)
    try:
        rows = db.execute("SELECT user_agent FROM user_sessions WHERE revoked_at IS NULL AND expires_at > CAST(strftime('%s','now') AS INTEGER)").fetchall()
    except Exception:
        rows = []
    for row in rows:
        user_agent = row["user_agent"] or ""
        _increment(platforms, classify_platform_from_strings("", user_agent))
        browser = _browser_name(user_agent)
        if browser:
            _increment(browsers, browser)
        _increment(app_types, _app_type(user_agent))
        _increment(operating_systems, _os_name(user_agent))
    return {
        "total_active_sessions": len(rows),
        "active": {
            "platforms": dict(sorted(platforms.items())),
            "browsers": dict(sorted(browsers.items())),
            "app_types": dict(sorted(app_types.items())),
            "operating_systems": dict(sorted(operating_systems.items())),
        },
        "historical": _historical_client_mix(db, days=days),
    }


def platform_distribution(db) -> dict[str, int]:
    return platform_analysis(db)["active"]["platforms"]


def _metric_totals(db, key: str, *, days: int) -> dict[str, Any]:
    today = _now_utc().date()
    cutoff = _start_date(days)
    last7_cutoff = (today - timedelta(days=6)).isoformat()
    prev7_cutoff = (today - timedelta(days=13)).isoformat()
    rows = db.execute(
        """SELECT bucket_start, status_class, SUM(count) AS count
           FROM ops_counters
           WHERE substr(bucket_start, 1, 10) >= ? AND bucket_size = 'hour' AND key = ?
           GROUP BY bucket_start, status_class
           ORDER BY bucket_start""",
        (cutoff, key),
    ).fetchall()
    total = success = errors = last7 = prev7 = 0
    peak_hour = 0
    by_hour: dict[str, int] = defaultdict(int)
    for row in rows:
        bucket = row["bucket_start"]
        status = row["status_class"]
        count = int(row["count"] or 0)
        total += count
        by_hour[bucket] += count
        if status == "2xx":
            success += count
        elif status in {"4xx", "5xx"}:
            errors += count
        bucket_day = str(bucket)[:10]
        if bucket_day >= last7_cutoff:
            last7 += count
        elif bucket_day >= prev7_cutoff:
            prev7 += count
    if by_hour:
        peak_hour = max(by_hour.values())
    if prev7 > 0:
        trend_pct = round(((last7 - prev7) / prev7) * 100, 1)
    elif last7 > 0:
        trend_pct = 100.0
    else:
        trend_pct = 0.0
    return {
        "total": total,
        "success": success,
        "errors": errors,
        "error_rate": round((errors / total) * 100, 1) if total else 0.0,
        "avg_per_day": round(total / max(days, 1), 2),
        "peak_per_hour": peak_hour,
        "last_7_days": last7,
        "previous_7_days": prev7,
        "trend_pct": trend_pct,
    }


def _duration_average(db, category: str, key: str, *, days: int) -> dict[str, Any]:
    calls = _metric_totals(db, f"{key}_timed_calls", days=days)["total"]
    ms_total = _metric_totals(db, f"{key}_ms_total", days=days)["total"]
    return {
        "timed_calls": calls,
        "avg_ms": round(ms_total / calls, 1) if calls else None,
    }


def _llm_token_summary(db, *, days: int) -> dict[str, Any]:
    prompt = _metric_totals(db, "live_text_extract_prompt_tokens", days=days)["total"]
    completion = _metric_totals(db, "live_text_extract_completion_tokens", days=days)["total"]
    total = _metric_totals(db, "live_text_extract_total_tokens", days=days)["total"] or prompt + completion
    reasoning = _metric_totals(db, "live_text_extract_reasoning_tokens", days=days)["total"]
    return {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": total,
        "reasoning_tokens": reasoning,
        "avg_tokens_per_llm_call": None,
    }


def workload_summary_for_period(db, *, days: int) -> dict[str, Any]:
    days = _period_days(days)
    stt = _metric_totals(db, "live_audio_transcribe", days=days)
    llm = _metric_totals(db, "live_text_extract", days=days)
    audio = _metric_totals(db, "live_audio_segment", days=days)
    confirmed = _metric_totals(db, "confirmed_todos_request", days=days)
    stt_timing = _duration_average(db, "stt_timing", "live_audio_transcribe", days=days)
    llm_timing = _duration_average(db, "llm_timing", "live_text_extract", days=days)
    tokens = _llm_token_summary(db, days=days)
    if llm["total"]:
        tokens["avg_tokens_per_llm_call"] = round(tokens["total_tokens"] / llm["total"], 1) if tokens["total_tokens"] else None
    total_backend_ai_calls = stt["total"] + llm["total"]
    return {
        "days": days,
        "stt": {**stt, **stt_timing},
        "llm": {**llm, **llm_timing, "tokens": tokens},
        "audio_segments": audio,
        "confirmed_todo_requests": confirmed,
        "backend_ai_calls": {
            "total": total_backend_ai_calls,
            "avg_per_day": round(total_backend_ai_calls / max(days, 1), 2),
            "peak_per_hour": max(stt["peak_per_hour"], llm["peak_per_hour"]),
        },
    }


def workload_summary(db, *, days: int = 30) -> dict[str, Any]:
    requested_days = _period_days(days)
    return {
        "selected": workload_summary_for_period(db, days=requested_days),
        "periods": {
            "7d": workload_summary_for_period(db, days=7),
            "30d": workload_summary_for_period(db, days=30),
            "365d": workload_summary_for_period(db, days=365),
        },
        "series": {
            "llm": _daily_ops_series(db, "live_text_extract", days=requested_days),
            "stt": _daily_ops_series(db, "live_audio_transcribe", days=requested_days),
            "audio_segments": _daily_ops_series(db, "live_audio_segment", days=requested_days),
            "tokens": _daily_ops_series(db, "live_text_extract_total_tokens", days=requested_days),
        },
    }


def ops_counter_summary(db, *, days: int = 30) -> dict[str, Any]:
    days = _period_days(days)
    cutoff = _start_date(days)
    rows = db.execute(
        """SELECT category, key, platform, status_class, SUM(count) AS count
           FROM ops_counters
           WHERE substr(bucket_start, 1, 10) >= ? AND bucket_size = 'hour'
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


def data_coverage(db) -> dict[str, Any]:
    result: dict[str, Any] = {"ops_since": None, "inventory_since": None, "data_since": None}
    try:
        row = db.execute("SELECT MIN(bucket_start) AS since FROM ops_counters").fetchone()
        result["ops_since"] = str(row["since"] or "")[:10] or None
    except Exception:
        pass
    inventory_dates = []
    for table in ("users", "workspaces", "projects", "todos", "reminders", "location_reminders", "push_subscriptions"):
        try:
            row = db.execute(f"SELECT MIN(date(created_at)) AS since FROM {table} WHERE created_at IS NOT NULL").fetchone()
            if row and row["since"]:
                inventory_dates.append(str(row["since"]))
        except Exception:
            pass
    if inventory_dates:
        result["inventory_since"] = min(inventory_dates)
    candidates = [value for value in (result["ops_since"], result["inventory_since"]) if value]
    result["data_since"] = min(candidates) if candidates else None
    return result


def technical_stats(days: int = 30) -> dict[str, Any]:
    with get_db() as db:
        period_days = _period_days(days)
        platforms = platform_analysis(db, days=period_days)
        return {
            "period_days": period_days,
            "coverage": data_coverage(db),
            "database": database_size(),
            "counts": count_db_rows(db),
            "inventory": inventory_summary(db, days=period_days),
            "platforms": platforms["active"]["platforms"],
            "platform_analysis": platforms,
            "ops": ops_counter_summary(db, days=period_days),
            "workload": workload_summary(db, days=period_days),
        }


def _journal_units() -> list[str]:
    configured = os.environ.get("NIA_TODO_JOURNAL_UNIT") or os.environ.get("NIA_TODO_SERVICE_UNIT")
    if configured:
        return [configured]
    return ["nia-todo"]


def backfill_from_journal(days: int = 30) -> dict[str, Any]:
    """Import aggregated BrainDump counters from existing systemd access logs."""
    days = max(1, min(int(days or 30), RETENTION_DAYS))
    since = f"{days} days ago"
    imported = 0
    scanned = 0
    session_client_mix_imported = 0
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
        session_client_mix_imported = backfill_existing_session_client_mix(db)
    return {
        "days": days,
        "units_tried": units_tried,
        "log_lines_scanned": scanned,
        "counter_rows": len(aggregate),
        "imported_count": imported,
        "session_client_mix_imported": session_client_mix_imported,
    }
