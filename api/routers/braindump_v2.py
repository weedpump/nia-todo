"""BrainDump v2 text/session/live-debug endpoints."""

from __future__ import annotations

import asyncio
import ast
import json
import re
import sqlite3
import subprocess
import tempfile
import time
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from db import get_db
from routers.auth import require_auth
from routers.todos import (
    TodoCreate,
    _insert_location_reminder,
    _insert_reminder,
    _normalize_recurring_rule,
    _sync_default_due_reminder,
    _validate_todo_dates,
    _validate_todo_status,
    _validate_todo_target,
    fetch_todo,
    get_user_inbox_project_id,
)
from urllib.parse import urlparse

from services.braindump_config import build_effective_system_prompt, get_braindump_config, llm_chat_url, parse_extra_headers
from services.braindump_v2 import (
    append_text_segment,
    create_session,
    ensure_braindump_enabled,
    finalize_session,
    get_session,
)
from services.ops_stats import increment_duration_metric, increment_endpoint_counter, increment_llm_usage_metrics
from services.utils import sanitize_text
from services.websocket import broadcast_change


router = APIRouter(prefix="/api/braindump/v2")

BRAINDUMP_LLM_MAX_TOKENS_MIN = 1200
BRAINDUMP_LLM_MAX_TOKENS_DEFAULT = 2000
BRAINDUMP_LLM_MAX_TOKENS_RETRY = 3000
BRAINDUMP_LLM_MAX_TOKENS_CAP = 4000

WHISPER_MODELS = {
    "base": Path("/opt/whisper.cpp/models/ggml-base.bin"),
    "small": Path("/opt/whisper.cpp/models/ggml-small.bin"),
}
def _clean_title(value: str) -> str:
    value = str(value or "").strip(" .,:;!?-–—\t\n\r")
    return value[:1].upper() + value[1:] if value else ""


def _item_key(value: str) -> str:
    return re.sub(r"[^a-z0-9äöüß]+", "", value.lower())


def _candidate_key(candidate: dict) -> str:
    return _item_key(str(candidate.get("title") or ""))


def _keys_equivalent(left: str, right: str) -> bool:
    if left == right:
        return True
    if min(len(left), len(right)) < 4:
        return False
    return abs(len(left) - len(right)) <= 3 and (left.startswith(right) or right.startswith(left))


def _dedupe_normalized_candidates(candidates: list[dict]) -> list[dict]:
    result = []
    seen = []
    for candidate in candidates:
        key = _candidate_key(candidate)
        if not key or any(_keys_equivalent(key, existing) for existing in seen):
            continue
        seen.append(key)
        result.append(candidate)
    return result


def _parse_relative_temporal(value: str) -> tuple[str, bool] | None:
    raw = str(value or "").strip()
    clean = re.sub(r"\s+", " ", raw.lower())
    if not clean:
        return None
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", clean):
        try:
            parsed = datetime.fromisoformat(clean).astimezone()
            return parsed.isoformat(timespec="minutes"), False
        except ValueError:
            return None
    try:
        parsed = datetime.fromisoformat(clean.replace("Z", "+00:00"))
        return parsed.isoformat(timespec="minutes"), bool(re.search(r"[T ]\d{1,2}:\d{2}", raw))
    except ValueError:
        pass

    now = datetime.now().astimezone()
    days = None
    if "übermorgen" in clean or "uebermorgen" in clean or "day after tomorrow" in clean or "pasado mañana" in clean or "après-demain" in clean or "apres-demain" in clean:
        days = 2
    elif "morgen" in clean or "tomorrow" in clean or "mañana" in clean or "demain" in clean:
        days = 1
    elif "heute" in clean or "today" in clean or "hoy" in clean or "aujourd" in clean:
        days = 0
    if days is None:
        return None

    hour = 9
    minute = 0
    time_match = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*(?:uhr|h)?\b", clean)
    if time_match:
        hour = int(time_match.group(1))
        minute = int(time_match.group(2) or 0)
    elif re.search(r"abend|evening|soir|noche", clean):
        hour = 19
    elif re.search(r"nachmittag|afternoon|tarde", clean):
        hour = 15
    elif re.search(r"mittag|noon|midi|mediod", clean):
        hour = 12
    elif re.search(r"morgen früh|früh|morning|matin|mañana", clean):
        hour = 9
    if hour > 23 or minute > 59:
        return None
    target = (now + timedelta(days=days)).replace(hour=hour, minute=minute, second=0, microsecond=0)
    return target.isoformat(timespec="minutes"), bool(time_match or re.search(r"abend|evening|soir|noche|nachmittag|afternoon|tarde|mittag|noon|midi|mediod|morgen früh|früh|morning|matin", clean))


def _temporal_has_explicit_time(value) -> bool:
    parsed_result = _parse_relative_temporal(str(value))
    return bool(parsed_result and parsed_result[1])


def _normalize_temporal_field(value, *, require_time: bool = False, transcript: str = "") -> str | None:
    if value in (None, ""):
        return None
    parsed_result = _parse_relative_temporal(str(value))
    if not parsed_result:
        return None
    parsed, has_explicit_time = parsed_result
    if re.search(r"abend|evening|soir|noche", transcript or "", re.IGNORECASE) and re.search(r"T23:59(?::00)?", parsed):
        parsed = re.sub(r"T23:59(?::00)?", "T19:00", parsed)
        has_explicit_time = True
    if require_time and not has_explicit_time:
        return None
    return parsed


def _normalize_location_reminder_candidate(candidate: dict, workspace_context: dict | None) -> dict | None:
    raw = candidate.get("location_reminder") or candidate.get("locationReminder") or candidate.get("location") or candidate.get("place")
    if not raw:
        return None
    if isinstance(raw, str):
        raw = {"place_name": raw}
    if not isinstance(raw, dict):
        return None
    trigger_type = str(raw.get("trigger_type") or raw.get("trigger") or "arrival").strip().lower()
    if trigger_type in {"arrive", "arriving", "enter", "at", "near", "on_arrival"}:
        trigger_type = "arrival"
    elif trigger_type in {"leave", "leaving", "exit", "on_departure"}:
        trigger_type = "departure"
    if trigger_type not in {"arrival", "departure"}:
        return None
    places = (workspace_context or {}).get("places") or []
    place_name = str(raw.get("place_name") or raw.get("placeName") or raw.get("saved_place") or raw.get("savedPlace") or raw.get("name") or "").strip()
    place_id = raw.get("place_id") or raw.get("placeId")
    matched = None
    if place_id not in (None, ""):
        try:
            place_id_int = int(place_id)
        except (TypeError, ValueError):
            place_id_int = None
        matched = next((place for place in places if int(place.get("id") or 0) == place_id_int), None) if place_id_int else None
    if not matched and place_name:
        normalized_name = _name_key(place_name)
        matched = next((place for place in places if _name_key(place.get("name")) == normalized_name), None)
    if not matched:
        return None
    return {
        "trigger_type": trigger_type,
        "place_id": int(matched["id"]),
        "place_name": matched["name"],
        "address": matched["address"],
        "enabled": True,
        "source": "braindump",
    }


def _route_workspace_candidate(candidate: dict, workspace_context: dict | None) -> dict:
    projects = (workspace_context or {}).get("projects") or []
    routed = dict(candidate)
    routed["location_reminder"] = _normalize_location_reminder_candidate(candidate, workspace_context)
    if not projects:
        routed["project_name"] = None
        routed["section_name"] = None
        return routed
    project_name = str(routed.get("project_name") or "").strip()
    section_name = str(routed.get("section_name") or "").strip()
    project_names = {str(project.get("name") or "").lower(): project for project in projects}
    if not project_name:
        routed["project_name"] = None
        routed["section_name"] = None
        return routed
    if project_name.lower() not in project_names:
        routed["project_name"] = None
        routed["section_name"] = None
        return routed
    project = project_names.get(project_name.lower())
    if project and section_name:
        known_sections = {str(section).lower() for section in project.get("sections") or []}
        if section_name.lower() not in known_sections:
            routed["section_name"] = None
    return routed


def _normalize_llm_response_shape(parsed):
    if isinstance(parsed, list):
        return {"candidates": parsed}
    if not isinstance(parsed, dict):
        raise ValueError("LLM JSON response must be an object or array")
    if isinstance(parsed.get("candidates"), list):
        return parsed
    if any(parsed.get(key) for key in ("title", "task", "text", "item", "name")):
        return {"candidates": [parsed]}
    for key in ("todos", "tasks", "items", "todo_candidates"):
        if isinstance(parsed.get(key), list):
            result = dict(parsed)
            result["candidates"] = parsed[key]
            return result
    return parsed


def _strip_json_comments(value: str) -> str:
    value = re.sub(r"(?m)^\s*//.*$", "", value)
    value = re.sub(r"/\*.*?\*/", "", value, flags=re.DOTALL)
    return value


def _json_loads_lenient(value: str):
    attempts = [value]
    stripped = _strip_json_comments(value)
    if stripped != value:
        attempts.append(stripped)
    no_trailing_commas = re.sub(r",\s*([}\]])", r"\1", stripped)
    if no_trailing_commas not in attempts:
        attempts.append(no_trailing_commas)
    last_error = None
    for attempt in attempts:
        try:
            return json.loads(attempt)
        except json.JSONDecodeError as exc:
            last_error = exc
    try:
        return ast.literal_eval(no_trailing_commas)
    except (SyntaxError, ValueError) as exc:
        last_error = exc
    raise last_error or ValueError("invalid JSON")


def _extract_llm_message_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text") or item.get("content") or item.get("value")
                if text:
                    parts.append(str(text))
        return "\n".join(parts)
    return str(content or "")


def _parse_llm_json_content(content) -> dict:
    """Parse OpenAI-compatible LLM content, tolerating common local-model JSON variants."""
    raw = _extract_llm_message_text(content).strip()
    if not raw:
        raise ValueError("LLM response was empty")
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", raw, flags=re.IGNORECASE)
    candidates = [raw]
    if fenced:
        candidates.insert(0, fenced.group(1).strip())
    for open_char, close_char in (("{", "}"), ("[", "]")):
        first = raw.find(open_char)
        last = raw.rfind(close_char)
        if first != -1 and last > first:
            candidates.append(raw[first:last + 1])
    last_error = None
    for candidate in candidates:
        try:
            return _normalize_llm_response_shape(_json_loads_lenient(candidate))
        except (json.JSONDecodeError, ValueError) as exc:
            last_error = exc
            continue
    raise ValueError(f"Could not parse LLM JSON response: {last_error}")



def _recurrence_interval_from_text(raw: str) -> int:
    number_words = {
        "one": 1, "ein": 1, "eine": 1, "einen": 1,
        "two": 2, "zwei": 2,
        "three": 3, "drei": 3,
        "four": 4, "vier": 4,
        "five": 5, "fünf": 5, "fuenf": 5,
        "six": 6, "sechs": 6,
        "seven": 7, "sieben": 7,
        "eight": 8, "acht": 8,
        "nine": 9, "neun": 9,
        "ten": 10, "zehn": 10,
        "eleven": 11, "elf": 11,
        "twelve": 12, "zwölf": 12, "zwoelf": 12,
    }
    interval_match = re.search(r"\b(\d{1,3})\b", raw)
    if interval_match:
        return int(interval_match.group(1))
    for word, value in number_words.items():
        if re.search(rf"\b{re.escape(word)}\b", raw):
            return value
    return 1


def _normalize_braindump_recurring_rule(value, *, has_deadline: bool) -> dict | None:
    """Normalize LLM recurrence hints for BrainDump candidates.

    Recurring todos require a start date in nia-todo. BrainDump does not ask
    follow-up questions; without a deadline, recurrence is intentionally ignored.
    """
    if not has_deadline or not value:
        return None
    if isinstance(value, str):
        raw = value.strip().lower()
        if not raw or raw in {"none", "null", "no", "nein", "false"}:
            return None
        if any(token in raw for token in ("half year", "six months", "6 months", "sechs monate", "halbjahr", "halbes jahr", "halbe jahr", "halbjähr", "halbjaehr")):
            value = {"frequency": "monthly", "interval": 6}
        else:
            frequency = None
            if any(token in raw for token in ("daily", "day", "täglich", "taeglich", "jeden tag")):
                frequency = "daily"
            elif any(token in raw for token in ("weekly", "week", "wöchentlich", "woechentlich", "woche")):
                frequency = "weekly"
            elif any(token in raw for token in ("monthly", "month", "monat")):
                frequency = "monthly"
            elif any(token in raw for token in ("yearly", "annual", "year", "jährlich", "jaehrlich", "jahr")):
                frequency = "yearly"
            if not frequency:
                return None
            value = {"frequency": frequency, "interval": _recurrence_interval_from_text(raw)}
    if not isinstance(value, dict):
        return None
    frequency = str(value.get("frequency") or value.get("freq") or "").strip().lower()
    if frequency in {"", "none", "null"}:
        return None
    if frequency in {"day", "days"}:
        frequency = "daily"
    elif frequency in {"week", "weeks"}:
        frequency = "weekly"
    elif frequency in {"month", "months"}:
        frequency = "monthly"
    elif frequency in {"year", "years", "annual", "annually"}:
        frequency = "yearly"
    interval = value.get("interval") or value.get("every") or 1
    try:
        normalized = _normalize_recurring_rule({"frequency": frequency, "interval": int(interval)})
    except HTTPException:
        return None
    return json.loads(normalized) if normalized else None

def _normalize_braindump_json(parsed: dict, transcript: str, workspace_context: dict | None = None) -> dict:
    try:
        parsed = _normalize_llm_response_shape(parsed)
    except ValueError:
        parsed = {}
    candidates = parsed.get("candidates") if isinstance(parsed, dict) else None
    if not isinstance(candidates, list):
        candidates = []
    normalized = []
    for candidate in candidates:
        if isinstance(candidate, str):
            candidate = {"title": candidate}
        if not isinstance(candidate, dict):
            continue
        title = str(candidate.get("title") or candidate.get("task") or candidate.get("text") or candidate.get("item") or candidate.get("name") or "").strip()
        if not title:
            continue
        title = _clean_title(title)
        project_name = candidate.get("project_name") or candidate.get("projectName")
        deadline_source = candidate.get("deadline") or candidate.get("due") or candidate.get("due_date") or candidate.get("dueDate") or candidate.get("due_datetime") or candidate.get("dueDatetime")
        reminder_source = candidate.get("reminder") or candidate.get("remind_at") or candidate.get("reminder_at") or candidate.get("remindAt") or candidate.get("reminderAt") or candidate.get("reminder_datetime") or candidate.get("reminderDatetime")
        deadline = _normalize_temporal_field(deadline_source, transcript=transcript)
        reminder = _normalize_temporal_field(reminder_source, require_time=True, transcript=transcript)
        if deadline and reminder_source and not reminder and _temporal_has_explicit_time(deadline_source):
            reminder = deadline
        recurring_source = candidate.get("recurring_rule") or candidate.get("recurringRule") or candidate.get("repeat") or candidate.get("recurrence") or candidate.get("repetition")
        normalized.append(_route_workspace_candidate({
            "title": title,
            "project_name": project_name or candidate.get("project"),
            "section_name": candidate.get("section_name") or candidate.get("sectionName") or candidate.get("section"),
            "deadline": deadline,
            "reminder": reminder,
            "recurring_rule": _normalize_braindump_recurring_rule(recurring_source, has_deadline=bool(deadline)),
            "location_reminder": candidate.get("location_reminder") or candidate.get("locationReminder") or candidate.get("location") or candidate.get("place"),
        }, workspace_context))
    return {"candidates": _dedupe_normalized_candidates(normalized)}


class TextSegmentRequest(BaseModel):
    text: str
    final: bool = True


class BrainDumpTodoCandidate(BaseModel):
    title: str
    notes: str = ""
    project_name: str | None = None
    section_name: str | None = None
    deadline: str | None = None
    reminder: str | None = None
    recurring_rule: dict | None = None
    location_reminder: dict | None = None
    original_project_name: str | None = None
    original_section_name: str | None = None
    original_route_present: bool = False


class BrainDumpCreateTodosRequest(BaseModel):
    candidates: list[BrainDumpTodoCandidate]
    workspace_id: int | None = None


class BrainDumpLearningSettingsRequest(BaseModel):
    enabled: bool


class BrainDumpExtractRequest(BaseModel):
    transcript: str
    segment_id: int
    audio_start_ms: int = 0
    audio_end_ms: int = 0
    workspace_id: int | None = None


def _run(cmd: list[str]) -> tuple[float, subprocess.CompletedProcess[str]]:
    started = time.perf_counter()
    proc = subprocess.run(cmd, capture_output=True, text=True)
    elapsed_ms = (time.perf_counter() - started) * 1000
    return elapsed_ms, proc


def _load_local_openclaw_token() -> str | None:
    path = Path.home() / ".openclaw" / "openclaw.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text()).get("gateway", {}).get("auth", {}).get("token")
    except Exception:
        return None


def _convert_audio_to_wav(source: Path, target: Path) -> float:
    elapsed_ms, proc = _run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(source),
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
        str(target),
    ])
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "ffmpeg conversion failed")
    return elapsed_ms


def _transcribe_wav(wav: Path, model_name: str) -> tuple[float, str]:
    model = WHISPER_MODELS.get(model_name) or WHISPER_MODELS["base"]
    if not model.exists():
        raise RuntimeError(f"Whisper model missing: {model}")
    elapsed_ms, proc = _run([
        "whisper-cli",
        "-m", str(model),
        "-l", "auto",
        "-nt",
        "-np",
        "-mc", "0",
        "-t", "4",
        "-bo", "1",
        "-bs", "1",
        "-nf",
        str(wav),
    ])
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "whisper-cli failed")
    return elapsed_ms, " ".join(proc.stdout.split())


def _build_multipart_form_data(fields: dict[str, str], files: dict[str, tuple[str, bytes, str]]) -> tuple[bytes, str]:
    boundary = f"----nia-todo-braindump-{int(time.time() * 1000)}"
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"))
        chunks.append(str(value).encode("utf-8"))
        chunks.append(b"\r\n")
    for name, (filename, content, content_type) in files.items():
        safe_filename = filename.replace('"', "")
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(
            f'Content-Disposition: form-data; name="{name}"; filename="{safe_filename}"\r\n'
            f"Content-Type: {content_type}\r\n\r\n".encode("utf-8")
        )
        chunks.append(content)
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def _extract_transcript_from_stt_response(body: bytes, content_type: str) -> str:
    text = body.decode("utf-8", errors="replace")
    if "json" not in content_type.lower():
        return " ".join(text.split())
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"STT returned invalid JSON: {exc}") from exc
    transcript = payload.get("text") if isinstance(payload, dict) else None
    if not isinstance(transcript, str):
        raise RuntimeError("STT response is missing text")
    return " ".join(transcript.split())


def _transcribe_remote_whisper(audio: bytes, filename: str, content_type: str, config: dict) -> tuple[float, str]:
    stt_url = str(config.get("stt_url") or "").strip()
    if not stt_url:
        raise RuntimeError("BrainDump STT URL is not configured")
    fields = {
        "response_format": "json",
        "temperature": "0.0",
        "temperature_inc": "0.0",
    }
    language = str(config.get("stt_language") or "").strip()
    if language and language.lower() != "auto":
        fields["language"] = language
    body, multipart_type = _build_multipart_form_data(fields, {"file": (filename, audio, content_type)})
    headers = {"Content-Type": multipart_type}
    stt_token = str(config.get("stt_token") or "").strip()
    if stt_token:
        headers["Authorization"] = f"Bearer {stt_token}"
    req = urllib.request.Request(stt_url, data=body, headers=headers, method="POST")
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=float(config.get("stt_timeout_seconds") or 60)) as response:
            response_body = response.read()
            response_type = response.headers.get("content-type", "")
    except Exception as exc:
        raise RuntimeError(f"remote STT request failed: {exc}") from exc
    elapsed_ms = (time.perf_counter() - started) * 1000
    return elapsed_ms, _extract_transcript_from_stt_response(response_body, response_type)



def _user_default_workspace_id(db, user_id: int) -> int | None:
    row = db.execute(
        "SELECT id FROM workspaces WHERE user_id = ? AND COALESCE(is_default, 0) = 1 ORDER BY id LIMIT 1",
        (user_id,),
    ).fetchone()
    if row:
        return row["id"]
    row = db.execute("SELECT id FROM workspaces WHERE user_id = ? ORDER BY id LIMIT 1", (user_id,)).fetchone()
    return row["id"] if row else None


def _ensure_workspace_access(db, user_id: int, workspace_id: int | None) -> int | None:
    if workspace_id is None:
        return None
    row = db.execute("SELECT id FROM workspaces WHERE id = ? AND user_id = ?", (workspace_id, user_id)).fetchone()
    if not row:
        raise HTTPException(404, "Workspace not found")
    return workspace_id


def _workspace_inbox_project_id(db, user_id: int, workspace_id: int | None) -> int | None:
    if workspace_id is None:
        return get_user_inbox_project_id(db, user_id)
    row = db.execute(
        """SELECT id FROM projects
           WHERE user_id = ? AND workspace_id = ? AND COALESCE(is_inbox, 0) = 1
           ORDER BY id LIMIT 1""",
        (user_id, workspace_id),
    ).fetchone()
    if row:
        return row["id"]
    return get_user_inbox_project_id(db, user_id)


def _accessible_project_rows(db, user_id: int, *, workspace_id: int | None = None, limit: int | None = None):
    limit_sql = f"LIMIT {int(limit)}" if limit else ""
    default_workspace_id = _user_default_workspace_id(db, user_id)
    params: list[int] = [user_id, default_workspace_id or 0, user_id, user_id, default_workspace_id or 0, user_id]
    workspace_filter = ""
    if workspace_id is not None:
        workspace_filter = "AND CASE WHEN p.user_id = ? THEN p.workspace_id ELSE COALESCE(pm.workspace_id, ?) END = ?"
        params.extend([user_id, default_workspace_id or 0, workspace_id])
    return db.execute(
        f"""
        SELECT p.id, p.name, COALESCE(p.is_inbox, 0) AS is_inbox,
               p.parent_id,
               CASE WHEN p.user_id = ? THEN p.workspace_id ELSE COALESCE(pm.workspace_id, ?) END AS workspace_id,
               w.name AS workspace_name
        FROM projects p
        LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ? AND pm.status = 'accepted'
        LEFT JOIN workspaces w ON w.id = CASE WHEN p.user_id = ? THEN p.workspace_id ELSE COALESCE(pm.workspace_id, ?) END
        WHERE (p.user_id = ? OR pm.id IS NOT NULL)
          {workspace_filter}
        ORDER BY COALESCE(p.is_inbox, 0) DESC, p.sort_order, p.id
        {limit_sql}
        """,
        params,
    ).fetchall()


def _saved_places_context(db, user_id: int) -> list[dict]:
    rows = db.execute(
        """SELECT id, name, address, icon
           FROM saved_places
           WHERE user_id = ?
           ORDER BY lower(name), id
           LIMIT 80""",
        (user_id,),
    ).fetchall()
    return [
        {
            "id": row["id"],
            "name": row["name"],
            "address": row["address"],
            "icon": row["icon"],
        }
        for row in rows
    ]


def _load_braindump_workspace_context(db, user_id: int, workspace_id: int | None = None) -> dict:
    """Return a compact routing context for the BrainDump LLM.

    The extractor must not know hard-coded project names. It gets the user's
    actual structure and may choose exact names from it when the fit is clear.
    """
    workspace_id = _ensure_workspace_access(db, user_id, workspace_id)
    projects = _accessible_project_rows(db, user_id, workspace_id=workspace_id, limit=40)
    project_ids = [row["id"] for row in projects]
    sections_by_project: dict[int, list[str]] = {pid: [] for pid in project_ids}
    if project_ids:
        placeholders = ",".join("?" for _ in project_ids)
        sections = db.execute(
            f"""
            SELECT project_id, name
            FROM sections
            WHERE project_id IN ({placeholders})
            ORDER BY sort_order, id
            LIMIT 320
            """,
            project_ids,
        ).fetchall()
        for section in sections:
            sections_by_project.setdefault(section["project_id"], []).append(section["name"])
    places = _saved_places_context(db, user_id)
    workspace_names = [row["workspace_name"] for row in projects if row["workspace_name"]]
    return {
        "workspace_id": workspace_id,
        "workspace_name": workspace_names[0] if workspace_id is not None and workspace_names else None,
        "projects": [
            {
                "name": row["name"],
                "workspace": row["workspace_name"],
                "is_inbox": bool(row["is_inbox"]),
                "sections": sections_by_project.get(row["id"], []),
            }
            for row in projects
        ],
        "places": places,
    }


def _format_workspace_context(context: dict | None) -> str:
    projects = (context or {}).get("projects") or []
    places = (context or {}).get("places") or []
    workspace_name = (context or {}).get("workspace_name")
    payload = {
        "workspace_name": workspace_name,
        "rules": [
            "Use only exact project_name values from workspace.projects[].name, otherwise null.",
            "Use only section_name values listed inside the selected project's sections array, otherwise null.",
            "Never attach a section to a different project than the one where it is listed.",
            "Use only exact place_name values from workspace.places[].name for location_reminder, otherwise null.",
            "For location_reminder return only trigger_type and place_name; do not output addresses, coordinates, or radius.",
            "Return only the output object with candidates; do not copy workspace data into the output.",
        ],
        "projects": [
            {
                "name": str(project.get("name") or "")[:80],
                "sections": [str(section)[:60] for section in (project.get("sections") or [])[:16]],
            }
            for project in projects[:40]
            if str(project.get("name") or "").strip()
        ],
        "places": [
            {
                "name": str(place.get("name") or "")[:120],
            }
            for place in places[:80]
            if str(place.get("name") or "").strip()
        ],
    }
    if not payload["projects"]:
        payload["rules"].append("No projects are available; use project_name=null and section_name=null.")
    if not payload["places"]:
        payload["rules"].append("No saved places are available; use location_reminder=null.")
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    while len(text) > 5000 and len(payload["projects"]) > 1:
        payload["projects"] = payload["projects"][:-1]
        text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    while len(text) > 5000 and len(payload["places"]) > 1:
        payload["places"] = payload["places"][:-1]
        text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return text


def _name_key(value: str | None) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip()).casefold()


BRAINDUMP_LEARNING_MIN_TOKEN_LENGTH = 3
BRAINDUMP_LEARNING_MAX_TOKENS = 12
BRAINDUMP_LEARNING_APPLY_MIN_SCORE = 2
BRAINDUMP_LEARNING_APPLY_MIN_MARGIN = 2
BRAINDUMP_LEARNING_OVERRIDE_MIN_SCORE = 4
BRAINDUMP_LEARNING_OVERRIDE_MIN_MARGIN = 3

BRAINDUMP_LEARNING_STOPWORDS = {
    "aber", "alle", "alles", "also", "and", "auf", "aus", "bei", "bitte", "das", "den", "der", "die", "dies", "ein", "eine", "einen", "einer", "eines", "for", "für", "hab", "habe", "ich", "im", "in", "ist", "it", "mit", "nach", "noch", "oder", "of", "the", "to", "und", "vom", "von", "was", "wir", "zum", "zur",
    "add", "aufgabe", "besorgen", "brauche", "bring", "bringen", "buy", "erinnere", "erinnern", "holen", "kaufen", "mach", "machen", "need", "todo", "tun",
}


def _learning_tokens(title: str) -> list[str]:
    tokens = []
    seen = set()
    for token in re.findall(r"[\wäöüÄÖÜß]+", str(title or "").casefold(), flags=re.UNICODE):
        token = token.strip("_")
        if len(token) < BRAINDUMP_LEARNING_MIN_TOKEN_LENGTH or token.isdigit() or token in BRAINDUMP_LEARNING_STOPWORDS:
            continue
        if token in seen:
            continue
        seen.add(token)
        tokens.append(token)
        if len(tokens) >= BRAINDUMP_LEARNING_MAX_TOKENS:
            break
    return tokens


def _learning_enabled_for_user(db, user_id: int) -> bool:
    try:
        row = db.execute("SELECT COALESCE(braindump_learning_enabled, 1) AS enabled FROM users WHERE id = ?", (user_id,)).fetchone()
    except sqlite3.OperationalError:
        return True
    return bool(row and row["enabled"])


def _learning_row_count(db, user_id: int) -> int:
    try:
        row = db.execute("SELECT COUNT(*) AS count FROM braindump_route_learning WHERE user_id = ?", (user_id,)).fetchone()
    except sqlite3.OperationalError:
        return 0
    return int(row["count"] if row else 0)


def _learn_braindump_route(db, user_id: int, workspace_id: int | None, title: str, project_id: int | None, section_id: int | None, *, corrected: bool = False):
    if not _learning_enabled_for_user(db, user_id):
        return
    tokens = _learning_tokens(title)
    if not tokens or project_id is None:
        return
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    for token in tokens:
        cursor = db.execute(
            """
            UPDATE braindump_route_learning
            SET hits = hits + 1, last_used_at = ?
            WHERE user_id = ?
              AND ((workspace_id IS NULL AND ? IS NULL) OR workspace_id = ?)
              AND token = ?
              AND project_id = ?
              AND ((section_id IS NULL AND ? IS NULL) OR section_id = ?)
            """,
            (now, user_id, workspace_id, workspace_id, token, project_id, section_id, section_id),
        )
        if cursor.rowcount:
            continue
        insert_cursor = db.execute(
            """
            INSERT OR IGNORE INTO braindump_route_learning (user_id, workspace_id, token, project_id, section_id, hits, last_used_at)
            VALUES (?, ?, ?, ?, ?, 1, ?)
            """,
            (user_id, workspace_id, token, project_id, section_id, now),
        )
        if not insert_cursor.rowcount:
            db.execute(
                """
                UPDATE braindump_route_learning
                SET hits = hits + 1, last_used_at = ?
                WHERE user_id = ?
                  AND ((workspace_id IS NULL AND ? IS NULL) OR workspace_id = ?)
                  AND token = ?
                  AND project_id = ?
                  AND ((section_id IS NULL AND ? IS NULL) OR section_id = ?)
                """,
                (now, user_id, workspace_id, workspace_id, token, project_id, section_id, section_id),
            )
        if corrected:
            competitor = db.execute(
                """
                SELECT MAX(hits) AS max_hits
                FROM braindump_route_learning
                WHERE user_id = ?
                  AND ((workspace_id IS NULL AND ? IS NULL) OR workspace_id = ?)
                  AND token = ?
                  AND NOT (project_id = ? AND ((section_id IS NULL AND ? IS NULL) OR section_id = ?))
                """,
                (user_id, workspace_id, workspace_id, token, project_id, section_id, section_id),
            ).fetchone()
            desired_hits = int((competitor["max_hits"] if competitor else 0) or 0) + BRAINDUMP_LEARNING_OVERRIDE_MIN_MARGIN
            db.execute(
                """
                UPDATE braindump_route_learning
                SET hits = MAX(hits, ?), last_used_at = ?
                WHERE user_id = ?
                  AND ((workspace_id IS NULL AND ? IS NULL) OR workspace_id = ?)
                  AND token = ?
                  AND project_id = ?
                  AND ((section_id IS NULL AND ? IS NULL) OR section_id = ?)
                """,
                (desired_hits, now, user_id, workspace_id, workspace_id, token, project_id, section_id, section_id),
            )


def _candidate_route_ids(db, user_id: int, workspace_id: int | None, candidate: dict) -> tuple[int | None, int | None, bool]:
    project_id, project_matched = _resolve_project_target(db, user_id, candidate.get("project_name"), workspace_id)
    section_id = _resolve_section_id(db, project_id, candidate.get("section_name")) if project_matched else None
    return project_id, section_id, project_matched


def _route_name_lookup(db, user_id: int, workspace_id: int | None, project_ids: set[int], section_ids: set[int]) -> tuple[dict[int, str], dict[int, tuple[int, str]]]:
    project_names: dict[int, str] = {}
    section_names: dict[int, tuple[int, str]] = {}
    if project_ids:
        rows = _accessible_project_rows(db, user_id, workspace_id=workspace_id)
        allowed_project_ids = set(project_ids)
        for row in rows:
            if row["id"] in allowed_project_ids:
                project_names[row["id"]] = row["name"]
    if section_ids:
        placeholders = ",".join("?" for _ in section_ids)
        rows = db.execute(f"SELECT id, project_id, name FROM sections WHERE id IN ({placeholders})", list(section_ids)).fetchall()
        for row in rows:
            if row["project_id"] in project_names:
                section_names[row["id"]] = (row["project_id"], row["name"])
    return project_names, section_names


def _best_learned_route(db, user_id: int, workspace_id: int | None, title: str) -> tuple[int | None, int | None, int, int]:
    tokens = _learning_tokens(title)
    if not tokens:
        return None, None, 0, 0
    placeholders = ",".join("?" for _ in tokens)
    rows = db.execute(
        f"""
        SELECT project_id, section_id, SUM(hits) AS score
        FROM braindump_route_learning
        WHERE user_id = ?
          AND ((workspace_id IS NULL AND ? IS NULL) OR workspace_id = ?)
          AND token IN ({placeholders})
        GROUP BY project_id, section_id
        ORDER BY score DESC
        LIMIT 2
        """,
        [user_id, workspace_id, workspace_id, *tokens],
    ).fetchall()
    if not rows:
        return None, None, 0, 0
    best = rows[0]
    second_score = int(rows[1]["score"] if len(rows) > 1 else 0)
    return best["project_id"], best["section_id"], int(best["score"] or 0), second_score


def _apply_learned_routes(db, user_id: int, workspace_id: int | None, parsed: dict) -> dict:
    if not _learning_enabled_for_user(db, user_id):
        return parsed
    candidates = parsed.get("candidates") if isinstance(parsed, dict) else None
    if not isinstance(candidates, list):
        return parsed
    try:
        route_results = []
        project_ids: set[int] = set()
        section_ids: set[int] = set()
        for candidate in candidates:
            if not isinstance(candidate, dict):
                route_results.append(None)
                continue
            project_id, section_id, score, second_score = _best_learned_route(db, user_id, workspace_id, str(candidate.get("title") or ""))
            margin = score - second_score
            if project_id is None or score < BRAINDUMP_LEARNING_APPLY_MIN_SCORE or margin < BRAINDUMP_LEARNING_APPLY_MIN_MARGIN:
                route_results.append(None)
                continue
            project_ids.add(project_id)
            if section_id is not None:
                section_ids.add(section_id)
            route_results.append((project_id, section_id, score, margin))
        project_names, section_names = _route_name_lookup(db, user_id, workspace_id, project_ids, section_ids)
        routed_candidates = []
        for candidate, learned in zip(candidates, route_results):
            if not isinstance(candidate, dict) or not learned:
                routed_candidates.append(candidate)
                continue
            project_id, section_id, score, margin = learned
            project_name = project_names.get(project_id)
            if not project_name:
                routed_candidates.append(candidate)
                continue
            current_project_id, current_section_id, current_matched = _candidate_route_ids(db, user_id, workspace_id, candidate)
            has_existing_project = bool(candidate.get("project_name") and current_matched)
            has_existing_section = bool(has_existing_project and candidate.get("section_name") and current_section_id is not None)
            may_override = score >= BRAINDUMP_LEARNING_OVERRIDE_MIN_SCORE and margin >= BRAINDUMP_LEARNING_OVERRIDE_MIN_MARGIN
            if has_existing_project and current_project_id == project_id and current_section_id == section_id:
                routed_candidates.append(candidate)
                continue
            if has_existing_project and current_project_id == project_id and not has_existing_section:
                pass
            elif has_existing_project and not may_override:
                routed_candidates.append(candidate)
                continue
            routed = dict(candidate)
            routed["project_name"] = project_name
            if section_id is not None and section_id in section_names and section_names[section_id][0] == project_id:
                routed["section_name"] = section_names[section_id][1]
            else:
                routed["section_name"] = None
            routed_candidates.append(routed)
        return {**parsed, "candidates": routed_candidates}
    except sqlite3.OperationalError:
        return parsed


def _braindump_learning_settings(db, user_id: int) -> dict:
    enabled = _learning_enabled_for_user(db, user_id)
    return {"enabled": enabled, "learned_routes": _learning_row_count(db, user_id)}


def _reset_braindump_learning(db, user_id: int) -> int:
    try:
        cursor = db.execute("DELETE FROM braindump_route_learning WHERE user_id = ?", (user_id,))
    except sqlite3.OperationalError:
        return 0
    return int(cursor.rowcount or 0)


def _resolve_project_target(db, user_id: int, project_name: str | None, workspace_id: int | None = None) -> tuple[int | None, bool]:
    if not project_name:
        return _workspace_inbox_project_id(db, user_id, workspace_id), False
    rows = _accessible_project_rows(db, user_id, workspace_id=workspace_id)
    matches = [row for row in rows if _name_key(row["name"]) == _name_key(project_name)]
    if len(matches) != 1:
        return _workspace_inbox_project_id(db, user_id, workspace_id), False
    return matches[0]["id"], True


def _resolve_project_id(db, user_id: int, project_name: str | None, workspace_id: int | None = None) -> int | None:
    project_id, _matched = _resolve_project_target(db, user_id, project_name, workspace_id)
    return project_id


def _resolve_section_id(db, project_id: int | None, section_name: str | None) -> int | None:
    if not section_name or project_id is None:
        return None
    rows = db.execute("SELECT id, name FROM sections WHERE project_id = ?", (project_id,)).fetchall()
    matches = [row for row in rows if _name_key(row["name"]) == _name_key(section_name)]
    if len(matches) != 1:
        return None
    return matches[0]["id"]


def _create_todos_from_braindump_candidates(db, user_id: int, candidates: list[BrainDumpTodoCandidate], workspace_id: int | None = None) -> list[dict]:
    workspace_id = _ensure_workspace_access(db, user_id, workspace_id)
    if not candidates:
        raise HTTPException(422, "No BrainDump candidates selected")
    if len(candidates) > 50:
        raise HTTPException(422, "Too many BrainDump candidates")
    created = []
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    for candidate in candidates:
        title = sanitize_text(candidate.title)
        notes = sanitize_text(candidate.notes or "")
        if not title:
            raise HTTPException(422, "BrainDump candidate title is required")
        project_name = candidate.project_name
        section_name = candidate.section_name
        project_id, project_matched = _resolve_project_target(db, user_id, project_name, workspace_id)
        section_id = _resolve_section_id(db, project_id, section_name) if project_matched else None
        data = TodoCreate(
            title=title,
            description=notes,
            priority=3,
            status="pending",
            project_id=project_id,
            section_id=section_id,
            due_date=candidate.deadline,
            remind_at=candidate.reminder,
            recurring_rule=candidate.recurring_rule if candidate.deadline else None,
        )
        _validate_todo_dates(data)
        _validate_todo_status(data.status)
        _validate_todo_target(db, data.project_id, data.section_id, user_id)
        recurring_rule = _normalize_recurring_rule(data.recurring_rule) if data.due_date else None
        cursor = db.execute(
            """INSERT INTO todos
               (title, description, priority, is_pinned, status, project_id, section_id, due_date, completed_at, recurring_rule, updated_at, user_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (data.title, data.description, data.priority, int(bool(data.is_pinned)), data.status, data.project_id, data.section_id, data.due_date, None, recurring_rule, now, user_id),
        )
        todo_id = cursor.lastrowid
        if data.remind_at:
            _insert_reminder(db, todo_id, data.remind_at, user_id)
        else:
            _sync_default_due_reminder(db, todo_id, user_id, data.due_date)
        if candidate.location_reminder:
            location = _normalize_location_reminder_candidate({"location_reminder": candidate.location_reminder}, {"places": _saved_places_context(db, user_id)})
            if location:
                _insert_location_reminder(db, todo_id, user_id, location)
        todo = fetch_todo(db, todo_id, user_id)
        if todo:
            if project_matched:
                original_project_id, original_section_id, original_matched = None, None, False
                if candidate.original_project_name:
                    original_project_id, original_matched = _resolve_project_target(db, user_id, candidate.original_project_name, workspace_id)
                    original_section_id = _resolve_section_id(db, original_project_id, candidate.original_section_name) if original_matched else None
                corrected_route = bool(
                    candidate.original_route_present
                    and (not original_matched or original_project_id != data.project_id or original_section_id != data.section_id)
                )
                _learn_braindump_route(db, user_id, workspace_id, data.title, data.project_id, data.section_id, corrected=corrected_route)
            created.append(todo)
    return created


def _is_local_openclaw_base_url(base_url: str) -> bool:
    parsed = urlparse(str(base_url or ""))
    return parsed.hostname in {"127.0.0.1", "localhost"} and parsed.port == 18789




def _post_llm_chat(payload: dict, headers: dict[str, str], config: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        llm_chat_url(config),
        data=body,
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=float(config.get("llm_timeout_seconds") or 180)) as response:
        return json.loads(response.read().decode("utf-8"))


def _llm_request_payload(payload: dict, config: dict) -> dict:
    provider = str(config.get("llm_provider") or "openai_compatible").strip().lower()
    if provider == "ollama":
        options = {"temperature": payload.get("temperature", 0)}
        if payload.get("max_tokens"):
            options["num_predict"] = payload["max_tokens"]
        return {
            "model": payload["model"],
            "messages": payload["messages"],
            "stream": False,
            "options": options,
        }
    return payload


def _llm_response_content(result: dict, config: dict) -> str:
    provider = str(config.get("llm_provider") or "openai_compatible").strip().lower()
    if provider == "ollama":
        return str(result.get("message", {}).get("content") or "")
    return result["choices"][0]["message"].get("content", "")


def _llm_finish_reason(result: dict, config: dict) -> str | None:
    provider = str(config.get("llm_provider") or "openai_compatible").strip().lower()
    if provider == "ollama":
        done_reason = result.get("done_reason") or result.get("message", {}).get("done_reason")
        return str(done_reason) if done_reason else None
    choices = result.get("choices") or []
    if not choices:
        return None
    finish_reason = choices[0].get("finish_reason")
    return str(finish_reason) if finish_reason else None


def _llm_usage(result: dict, config: dict) -> dict | None:
    provider = str(config.get("llm_provider") or "openai_compatible").strip().lower()
    if provider == "ollama":
        usage = {
            "prompt_tokens": result.get("prompt_eval_count"),
            "completion_tokens": result.get("eval_count"),
        }
        usage = {key: value for key, value in usage.items() if value is not None}
        return usage or None
    usage = result.get("usage")
    return usage if isinstance(usage, dict) else None


def _llm_reasoning_tokens(usage: dict | None) -> int | None:
    if not usage:
        return None
    details = usage.get("completion_tokens_details")
    if not isinstance(details, dict):
        return None
    value = details.get("reasoning_tokens")
    return int(value) if isinstance(value, int) else None


def _braindump_llm_max_tokens(text: str, *, retry: bool = False) -> int:
    # Local reasoning models may spend completion tokens on hidden/internal thought before
    # emitting JSON. Scale by transcript length, but keep a safe default for short inputs.
    estimated = BRAINDUMP_LLM_MAX_TOKENS_DEFAULT + max(0, len(text) // 4)
    if retry:
        estimated = max(estimated, BRAINDUMP_LLM_MAX_TOKENS_RETRY)
    return max(BRAINDUMP_LLM_MAX_TOKENS_MIN, min(estimated, BRAINDUMP_LLM_MAX_TOKENS_CAP))


def _llm_empty_content_diagnostic(result: dict, config: dict, max_tokens: int) -> str:
    usage = _llm_usage(result, config)
    finish_reason = _llm_finish_reason(result, config)
    completion_tokens = usage.get("completion_tokens") if usage else None
    reasoning_tokens = _llm_reasoning_tokens(usage)
    parts = ["LLM response was empty"]
    if finish_reason:
        parts.append(f"finish_reason={finish_reason}")
    parts.append(f"max_tokens={max_tokens}")
    if completion_tokens is not None:
        parts.append(f"completion_tokens={completion_tokens}")
    if reasoning_tokens is not None:
        parts.append(f"reasoning_tokens={reasoning_tokens}")
    return "; ".join(parts)


def _should_retry_empty_llm_content(result: dict, config: dict) -> bool:
    finish_reason = (_llm_finish_reason(result, config) or "").lower()
    usage = _llm_usage(result, config)
    reasoning_tokens = _llm_reasoning_tokens(usage) or 0
    return finish_reason in {"length", "max_tokens"} or reasoning_tokens > 0


def _extract_with_llm(text: str, segment_id: int, workspace_context: dict | None = None, config: dict | None = None) -> tuple[float, dict, dict | None, str]:
    config = config or get_braindump_config(include_secrets=True)
    base_url = str(config.get("llm_base_url") or "").strip()
    token = str(config.get("llm_api_key") or "").strip()
    if not token and _is_local_openclaw_base_url(base_url):
        token = _load_local_openclaw_token() or ""
    system_prompt = build_effective_system_prompt(config)
    current_datetime = datetime.now().astimezone().isoformat(timespec="minutes")
    user_content = f"Current datetime: {current_datetime}\n\nWorkspace JSON:\n{_format_workspace_context(workspace_context)}\n\nTranscript:\n{text}"
    model_name = str(config.get("llm_model") or "").strip()
    if not model_name:
        raise RuntimeError("BrainDump LLM model is not configured")
    def build_payload(max_tokens: int, *, retry: bool = False) -> dict:
        retry_instruction = ""
        if retry:
            retry_instruction = "\n\nRetry instruction: the previous response did not provide final JSON content before its output budget ended. Return the compact JSON immediately in assistant message content. Keep any internal reasoning minimal."
        return {
            "model": model_name,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"{user_content}{retry_instruction}"},
            ],
            "temperature": 0,
            "stream": False,
            "max_tokens": max_tokens,
            "user": f"nia-todo-live-braindump-{segment_id}-{int(time.time() * 1000)}",
        }

    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    headers.update(parse_extra_headers(str(config.get("llm_extra_headers_json") or "")))

    def send_payload(payload_to_send: dict) -> dict:
        request_payload = _llm_request_payload(payload_to_send, config)
        try:
            return _post_llm_chat(request_payload, headers, config)
        except urllib.error.HTTPError as exc:
            if exc.code not in {400, 422} or "user" not in request_payload:
                raise
            request_payload = dict(request_payload)
            request_payload.pop("user", None)
            return _post_llm_chat(request_payload, headers, config)

    started = time.perf_counter()
    max_tokens = _braindump_llm_max_tokens(text)
    result = send_payload(build_payload(max_tokens))
    content = _llm_response_content(result, config)

    if not str(content or "").strip() and _should_retry_empty_llm_content(result, config):
        retry_max_tokens = _braindump_llm_max_tokens(text, retry=True)
        result = send_payload(build_payload(retry_max_tokens, retry=True))
        content = _llm_response_content(result, config)
        max_tokens = retry_max_tokens

    elapsed_ms = (time.perf_counter() - started) * 1000
    if not str(content or "").strip():
        raise RuntimeError(_llm_empty_content_diagnostic(result, config, max_tokens))
    parsed = _normalize_braindump_json(_parse_llm_json_content(content), text, workspace_context)
    return elapsed_ms, parsed, _llm_usage(result, config), json.dumps(parsed, ensure_ascii=False, separators=(",", ":"))


# Backward-compatible alias for older validation/probe scripts.
_extract_with_openclaw = _extract_with_llm


def require_braindump_access(user_id: int):
    config = get_braindump_config(include_secrets=True)
    if not config.get("enabled"):
        raise HTTPException(403, "BrainDump is disabled")
    with get_db() as db:
        try:
            ensure_braindump_enabled(db, user_id)
        except PermissionError as exc:
            if str(exc) == "user_not_found":
                raise HTTPException(404, "User not found")
            raise HTTPException(403, "BrainDump is not enabled for this user")


@router.get("/access")
def get_braindump_access(request: Request, user_id: int = Depends(require_auth)):
    try:
        require_braindump_access(user_id)
        enabled = True
        increment_endpoint_counter(request, "GET", "/api/braindump/v2/access", status_code=200)
    except HTTPException as exc:
        if exc.status_code == 403:
            enabled = False
            increment_endpoint_counter(request, "GET", "/api/braindump/v2/access", status_code=403)
        else:
            raise
    return {"enabled": enabled}


def _transcribe_live_audio_bytes(audio_bytes: bytes, content_type: str, segment_id: int, model: str, config: dict) -> tuple[float, float, str, str]:
    stt_provider = str(config.get("stt_provider") or "whisper_cpp_remote").strip().lower()
    if stt_provider not in {"whisper_cpp_remote", "local_whisper_cpp"}:
        raise RuntimeError(f"Unsupported BrainDump STT provider: {stt_provider}")
    if stt_provider == "local_whisper_cpp" and model not in WHISPER_MODELS:
        raise ValueError("Unsupported BrainDump STT model")
    if len(audio_bytes) < 1200:
        raise RuntimeError("audio segment too small")
    suffix = ".webm" if "webm" in content_type else ".ogg" if "ogg" in content_type else ".audio"
    if stt_provider == "whisper_cpp_remote":
        stt_ms, transcript = _transcribe_remote_whisper(audio_bytes, f"segment-{segment_id}{suffix}", content_type or "application/octet-stream", config)
        return 0.0, stt_ms, transcript, stt_provider
    with tempfile.TemporaryDirectory(prefix="nia-braindump-live-") as tmp:
        tmpdir = Path(tmp)
        raw_path = tmpdir / f"segment-{segment_id}{suffix}"
        wav_path = tmpdir / f"segment-{segment_id}.wav"
        raw_path.write_bytes(audio_bytes)
        convert_ms = _convert_audio_to_wav(raw_path, wav_path)
        stt_ms, transcript = _transcribe_wav(wav_path, model)
        return convert_ms, stt_ms, transcript, stt_provider


@router.post("/live/audio-segment/transcribe")
async def transcribe_live_audio_segment(
    request: Request,
    segment_id: int = Query(...),
    audio_start_ms: int = Query(0),
    audio_end_ms: int = Query(0),
    model: str = Query("base"),
    user_id: int = Depends(require_auth),
):
    """Transcribe one live BrainDump audio window. LLM extraction is a separate step."""
    require_braindump_access(user_id)
    config = get_braindump_config(include_secrets=True)
    received_at = time.perf_counter()
    content_type = request.headers.get("content-type", "")
    audio_bytes = await request.body()
    try:
        convert_ms, stt_ms, transcript, stt_provider = await asyncio.to_thread(
            _transcribe_live_audio_bytes, audio_bytes, content_type, segment_id, model, config
        )
    except ValueError as exc:
        increment_endpoint_counter(request, "POST", "/api/braindump/v2/live/audio-segment/transcribe", status_code=400)
        raise HTTPException(400, str(exc))
    except Exception as exc:
        increment_endpoint_counter(request, "POST", "/api/braindump/v2/live/audio-segment/transcribe", status_code=500)
        raise HTTPException(500, f"BrainDump transcription failed: {exc}")
    increment_endpoint_counter(request, "POST", "/api/braindump/v2/live/audio-segment/transcribe", status_code=200)
    increment_duration_metric("stt", "live_audio_transcribe", stt_ms)
    total_ms = (time.perf_counter() - received_at) * 1000
    return {
        "segment_id": segment_id,
        "audio_start_ms": audio_start_ms,
        "audio_end_ms": audio_end_ms,
        "model": model,
        "stt_provider": stt_provider,
        "transcript": transcript,
        "timing": {
            "convert_ms": round(convert_ms, 2),
            "stt_ms": round(stt_ms, 2),
            "total_ms": round(total_ms, 2),
        },
    }


@router.post("/live/text-segment/extract")
async def extract_live_text_segment(request: Request, data: BrainDumpExtractRequest, user_id: int = Depends(require_auth)):
    """Extract BrainDump candidates from a transcript returned by the STT step."""
    require_braindump_access(user_id)
    transcript = sanitize_text(data.transcript)
    if not transcript:
        increment_endpoint_counter(request, "POST", "/api/braindump/v2/live/text-segment/extract", status_code=422)
        raise HTTPException(422, "BrainDump transcript is required")
    config = get_braindump_config(include_secrets=True)
    received_at = time.perf_counter()
    with get_db() as db:
        workspace_context = _load_braindump_workspace_context(db, user_id, data.workspace_id)
    try:
        llm_ms, parsed, usage, raw_json = await asyncio.to_thread(
            _extract_with_llm, transcript, data.segment_id, workspace_context, config
        )
        with get_db() as db:
            parsed = _apply_learned_routes(db, user_id, data.workspace_id, parsed)
        raw_json = json.dumps(parsed, ensure_ascii=False, separators=(",", ":"))
    except Exception as exc:
        increment_endpoint_counter(request, "POST", "/api/braindump/v2/live/text-segment/extract", status_code=500)
        raise HTTPException(500, f"BrainDump extraction failed: {exc}")
    increment_endpoint_counter(request, "POST", "/api/braindump/v2/live/text-segment/extract", status_code=200)
    increment_duration_metric("llm", "live_text_extract", llm_ms)
    increment_llm_usage_metrics("live_text_extract", usage)
    total_ms = (time.perf_counter() - received_at) * 1000
    return {
        "segment_id": data.segment_id,
        "audio_start_ms": data.audio_start_ms,
        "audio_end_ms": data.audio_end_ms,
        "transcript": transcript,
        "json": parsed,
        "raw_json": raw_json,
        "usage": usage,
        "timing": {
            "llm_ms": round(llm_ms, 2),
            "total_ms": round(total_ms, 2),
        },
    }


@router.post("/live/audio-segment")
async def process_live_audio_segment(
    request: Request,
    segment_id: int = Query(...),
    audio_start_ms: int = Query(0),
    audio_end_ms: int = Query(0),
    model: str = Query("base"),
    workspace_id: int | None = Query(None),
    user_id: int = Depends(require_auth),
):
    """Backward-compatible combined live endpoint: transcribe, then extract."""
    require_braindump_access(user_id)
    config = get_braindump_config(include_secrets=True)
    received_at = time.perf_counter()
    content_type = request.headers.get("content-type", "")
    audio_bytes = await request.body()
    with get_db() as db:
        workspace_context = _load_braindump_workspace_context(db, user_id, workspace_id)
    stt_counted = False
    llm_counted = False
    try:
        convert_ms, stt_ms, transcript, stt_provider = await asyncio.to_thread(
            _transcribe_live_audio_bytes, audio_bytes, content_type, segment_id, model, config
        )
        increment_endpoint_counter(request, "POST", "/api/braindump/v2/live/audio-segment/transcribe", status_code=200)
        increment_duration_metric("stt", "live_audio_transcribe", stt_ms)
        stt_counted = True
        llm_ms, parsed, usage, raw_json = await asyncio.to_thread(
            _extract_with_llm, transcript, segment_id, workspace_context, config
        )
        increment_endpoint_counter(request, "POST", "/api/braindump/v2/live/text-segment/extract", status_code=200)
        increment_duration_metric("llm", "live_text_extract", llm_ms)
        increment_llm_usage_metrics("live_text_extract", usage)
        llm_counted = True
        with get_db() as db:
            parsed = _apply_learned_routes(db, user_id, workspace_id, parsed)
        raw_json = json.dumps(parsed, ensure_ascii=False, separators=(",", ":"))
    except ValueError as exc:
        increment_endpoint_counter(request, "POST", "/api/braindump/v2/live/audio-segment", status_code=400)
        if not stt_counted:
            increment_endpoint_counter(request, "POST", "/api/braindump/v2/live/audio-segment/transcribe", status_code=400)
        raise HTTPException(400, str(exc))
    except Exception as exc:
        increment_endpoint_counter(request, "POST", "/api/braindump/v2/live/audio-segment", status_code=500)
        if stt_counted and not llm_counted:
            increment_endpoint_counter(request, "POST", "/api/braindump/v2/live/text-segment/extract", status_code=500)
        elif not stt_counted:
            increment_endpoint_counter(request, "POST", "/api/braindump/v2/live/audio-segment/transcribe", status_code=500)
        raise HTTPException(500, f"BrainDump live segment failed: {exc}")
    increment_endpoint_counter(request, "POST", "/api/braindump/v2/live/audio-segment", status_code=200)
    total_ms = (time.perf_counter() - received_at) * 1000
    return {
        "segment_id": segment_id,
        "audio_start_ms": audio_start_ms,
        "audio_end_ms": audio_end_ms,
        "model": model,
        "stt_provider": stt_provider,
        "transcript": transcript,
        "json": parsed,
        "raw_json": raw_json,
        "usage": usage,
        "timing": {
            "convert_ms": round(convert_ms, 2),
            "stt_ms": round(stt_ms, 2),
            "llm_ms": round(llm_ms, 2),
            "total_ms": round(total_ms, 2),
        },
    }


@router.get("/learning")
def get_braindump_learning_settings(user_id: int = Depends(require_auth)):
    """Return the current user's local BrainDump route-learning settings."""
    require_braindump_access(user_id)
    with get_db() as db:
        return _braindump_learning_settings(db, user_id)


@router.patch("/learning")
def update_braindump_learning_settings(data: BrainDumpLearningSettingsRequest, user_id: int = Depends(require_auth)):
    """Enable or disable local BrainDump route learning for the current user."""
    require_braindump_access(user_id)
    with get_db() as db:
        user = db.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
        if not user:
            raise HTTPException(404, "User not found")
        db.execute("UPDATE users SET braindump_learning_enabled = ? WHERE id = ?", (1 if data.enabled else 0, user_id))
        if not data.enabled:
            _reset_braindump_learning(db, user_id)
        db.commit()
        return _braindump_learning_settings(db, user_id)


@router.delete("/learning")
def reset_braindump_learning(user_id: int = Depends(require_auth)):
    """Reset only the current user's learned BrainDump route counters."""
    require_braindump_access(user_id)
    with get_db() as db:
        deleted = _reset_braindump_learning(db, user_id)
        db.commit()
        settings = _braindump_learning_settings(db, user_id)
    return {**settings, "deleted": deleted}


@router.post("/todos")
async def create_todos_from_braindump(request: Request, data: BrainDumpCreateTodosRequest, user_id: int = Depends(require_auth)):
    """Create real todos from user-confirmed BrainDump candidates."""
    require_braindump_access(user_id)
    try:
        with get_db() as db:
            created = _create_todos_from_braindump_candidates(db, user_id, data.candidates, data.workspace_id)
            db.commit()
    except HTTPException as exc:
        increment_endpoint_counter(request, "POST", "/api/braindump/v2/todos", status_code=exc.status_code)
        raise
    except Exception:
        increment_endpoint_counter(request, "POST", "/api/braindump/v2/todos", status_code=500)
        raise
    increment_endpoint_counter(request, "POST", "/api/braindump/v2/todos", status_code=200)
    for todo in created:
        await broadcast_change("todo_create", todo, user_id, todo.get("project_id"))
    return {"todos": created}


@router.post("/sessions")
def create_braindump_session(request: Request, user_id: int = Depends(require_auth)):
    require_braindump_access(user_id)
    session = create_session(user_id).to_dict()
    increment_endpoint_counter(request, "POST", "/api/braindump/v2/sessions", status_code=200)
    return session


@router.get("/sessions/{session_id}")
def get_braindump_session(session_id: str, user_id: int = Depends(require_auth)):
    require_braindump_access(user_id)
    try:
        return get_session(session_id, user_id).to_dict()
    except KeyError:
        raise HTTPException(404, "BrainDump session not found")


@router.post("/sessions/{session_id}/segments/text")
def add_braindump_text_segment(request: Request, session_id: str, data: TextSegmentRequest, user_id: int = Depends(require_auth)):
    require_braindump_access(user_id)
    text = sanitize_text(data.text)
    try:
        session = append_text_segment(session_id, user_id, text, data.final).to_dict()
        increment_endpoint_counter(request, "POST", f"/api/braindump/v2/sessions/{session_id}/segments/text", status_code=200)
        return session
    except KeyError:
        increment_endpoint_counter(request, "POST", f"/api/braindump/v2/sessions/{session_id}/segments/text", status_code=404)
        raise HTTPException(404, "BrainDump session not found")
    except ValueError as exc:
        increment_endpoint_counter(request, "POST", f"/api/braindump/v2/sessions/{session_id}/segments/text", status_code=409)
        raise HTTPException(409, str(exc))


@router.post("/sessions/{session_id}/finalize")
def finalize_braindump_session(request: Request, session_id: str, user_id: int = Depends(require_auth)):
    require_braindump_access(user_id)
    try:
        session = finalize_session(session_id, user_id).to_dict()
        increment_endpoint_counter(request, "POST", f"/api/braindump/v2/sessions/{session_id}/finalize", status_code=200)
        return session
    except KeyError:
        increment_endpoint_counter(request, "POST", f"/api/braindump/v2/sessions/{session_id}/finalize", status_code=404)
        raise HTTPException(404, "BrainDump session not found")
