"""nia-todo: Todo endpoints"""

import calendar
import json
import re
import secrets
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import quote, unquote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError, available_timezones
from fastapi import APIRouter, HTTPException, Depends, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from db import get_db, row_to_dict, now_iso
from paths import ATTACHMENT_DIR
from routers.auth import require_auth
from services.websocket import broadcast_change
from services.utils import sanitize_text
from services.sharing import can_access_project, can_manage_todos, get_project_ids_for_user
from services.attachments import MAX_ATTACHMENT_BYTES, attachment_usage_payload, enforce_attachment_upload_policy, sniff_attachment_content_type

router = APIRouter(prefix="/api/todos")


# ─── Pydantic Models ─────────────────────────────────────────────────────────

class TodoSubtaskInput(BaseModel):
    id: Optional[int] = None
    title: str
    is_done: bool = False
    sort_order: Optional[int] = None

class TodoCreate(BaseModel):
    title: str
    description: str = ""
    priority: int = Field(default=3, ge=1, le=4)
    is_pinned: bool = False
    status: str = "pending"
    project_id: Optional[int] = None
    section_id: Optional[int] = None
    due_date: Optional[str] = None
    remind_at: Optional[str] = None
    location_reminder: Optional[dict] = None
    recurring_rule: Optional[dict] = None
    subtasks: list[TodoSubtaskInput] = Field(default_factory=list)
    confirm_incomplete_subtasks_completion: bool = False

class TodoUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    priority: Optional[int] = None
    is_pinned: Optional[bool] = None
    status: Optional[str] = None
    project_id: Optional[int] = None
    section_id: Optional[int] = None
    due_date: Optional[str] = None
    remind_at: Optional[str] = None
    location_reminder: Optional[dict] = None
    recurring_rule: Optional[dict] = None
    subtasks: Optional[list[TodoSubtaskInput]] = None
    confirm_incomplete_subtasks_completion: bool = False

class TodoCommentCreate(BaseModel):
    body: str

class TodoCommentUpdate(BaseModel):
    body: str

class TodoSubtaskCreate(BaseModel):
    title: str
    is_done: bool = False
    sort_order: Optional[int] = None

class TodoSubtaskUpdate(BaseModel):
    title: Optional[str] = None
    is_done: Optional[bool] = None
    sort_order: Optional[int] = None


# ─── Helpers ───────────────────────────────────────────────────────────────────

ALLOWED_TODO_STATUSES = {"pending", "in_progress", "done"}
ALLOWED_RECURRENCE_FREQUENCIES = {"daily", "weekly", "monthly", "yearly"}
ALLOWED_LOCATION_TRIGGERS = {"arrival", "departure"}
ALLOWED_TIMEZONES = available_timezones() - {"localtime"}
FORBIDDEN_LOCATION_COORDINATE_FIELDS = {
    "lat", "lng", "latitude", "longitude", "lon",
    "radius", "radius_m", "radiusM", "radiusMeters", "radius_meters",
}
AUTO_REMINDER_SOURCE = "default_due"
EXPLICIT_REMINDER_SOURCE = "explicit"
MAX_ATTACHMENTS_PER_TODO = 20


def get_user_inbox_project_id(db, user_id: int) -> Optional[int]:
    row = db.execute(
        "SELECT id FROM projects WHERE user_id = ? AND COALESCE(is_inbox, 0) = 1 ORDER BY id LIMIT 1",
        (user_id,)
    ).fetchone()
    return row['id'] if row else None


def _subtasks_for_todo(db, todo_id: int) -> list[dict]:
    rows = db.execute(
        """SELECT id, title, is_done, sort_order, created_at, updated_at
           FROM todo_subtasks
           WHERE todo_id = ?
           ORDER BY sort_order, id""",
        (todo_id,)
    ).fetchall()
    return [{**dict(row), 'is_done': bool(row['is_done'])} for row in rows]


def _comments_for_todo(db, todo_id: int) -> list[dict]:
    rows = db.execute(
        """SELECT tc.id, tc.todo_id, tc.user_id, tc.body, tc.created_at, tc.updated_at,
                  u.username AS author_username, u.display_name AS author_display_name
           FROM todo_comments tc
           LEFT JOIN users u ON u.id = tc.user_id
           WHERE tc.todo_id = ?
           ORDER BY tc.created_at, tc.id""",
        (todo_id,)
    ).fetchall()
    return [dict(row) for row in rows]



def _attachment_table_exists(db) -> bool:
    row = db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'todo_attachments'").fetchone()
    return bool(row)


def _attachments_for_todo(db, todo_id: int) -> list[dict]:
    if not _attachment_table_exists(db):
        return []
    rows = db.execute(
        """SELECT ta.id, ta.todo_id, ta.user_id, ta.original_filename, ta.content_type, ta.size_bytes,
                  ta.created_at, u.username AS uploader_username, u.display_name AS uploader_display_name
           FROM todo_attachments ta
           LEFT JOIN users u ON u.id = ta.user_id
           WHERE ta.todo_id = ?
           ORDER BY ta.created_at, ta.id""",
        (todo_id,)
    ).fetchall()
    return [dict(row) for row in rows]


def _attachment_count_for_todo(db, todo_id: int) -> int:
    if not _attachment_table_exists(db):
        return 0
    row = db.execute("SELECT COUNT(*) AS count FROM todo_attachments WHERE todo_id = ?", (todo_id,)).fetchone()
    return int(row['count'] if row else 0)


def _attachment_event_payload(db, todo_id: int, *, attachment: dict | None = None, attachment_id: int | None = None) -> dict:
    row = db.execute("SELECT updated_at FROM todos WHERE id = ?", (todo_id,)).fetchone()
    payload = {
        "todo_id": todo_id,
        "attachments_count": _attachment_count_for_todo(db, todo_id),
        "updated_at": row['updated_at'] if row else now_iso(),
    }
    if attachment is not None:
        payload["attachment"] = attachment
    if attachment_id is not None:
        payload["attachment_id"] = attachment_id
    return payload


def _attachment_row(db, attachment_id: int) -> dict | None:
    row = db.execute(
        """SELECT ta.id, ta.todo_id, ta.user_id, ta.original_filename, ta.stored_filename,
                  ta.content_type, ta.size_bytes, ta.created_at,
                  u.username AS uploader_username, u.display_name AS uploader_display_name
           FROM todo_attachments ta
           LEFT JOIN users u ON u.id = ta.user_id
           WHERE ta.id = ?""",
        (attachment_id,)
    ).fetchone()
    return dict(row) if row else None


def _public_attachment(row: dict) -> dict:
    return {k: row.get(k) for k in (
        'id', 'todo_id', 'user_id', 'original_filename', 'content_type', 'size_bytes',
        'created_at', 'uploader_username', 'uploader_display_name'
    )}


def _safe_attachment_filename(raw_name: str | None) -> str:
    name = unquote(str(raw_name or '')).replace('\\', '/').split('/')[-1].strip()
    name = sanitize_text(name) or 'attachment'
    name = re.sub(r'[^A-Za-z0-9._ -]+', '_', name).strip(' ._') or 'attachment'
    if len(name) > 180:
        stem = Path(name).stem[:140] or 'attachment'
        suffix = Path(name).suffix[:20]
        name = f"{stem}{suffix}"
    return name


def _stored_attachment_path(todo_id: int, stored_filename: str) -> Path:
    base = (ATTACHMENT_DIR / str(todo_id)).resolve()
    target = (base / stored_filename).resolve()
    if base not in target.parents and target != base:
        raise HTTPException(400, "Invalid attachment path")
    return target


def _normalize_comment_body(body: str) -> str:
    normalized = sanitize_text(body or '').strip()
    if not normalized:
        raise HTTPException(422, "Comment body required")
    if len(normalized) > 5000:
        raise HTTPException(422, "Comment body too long")
    return normalized


def _comment_count_for_todo(db, todo_id: int) -> int:
    row = db.execute("SELECT COUNT(*) AS count FROM todo_comments WHERE todo_id = ?", (todo_id,)).fetchone()
    return int(row['count'] if row else 0)


def _comment_event_payload(db, todo_id: int, *, comment: dict | None = None, comment_id: int | None = None) -> dict:
    row = db.execute("SELECT updated_at FROM todos WHERE id = ?", (todo_id,)).fetchone()
    payload = {
        "todo_id": todo_id,
        "comments_count": _comment_count_for_todo(db, todo_id),
        "updated_at": row['updated_at'] if row else now_iso(),
    }
    if comment is not None:
        payload["comment"] = comment
    if comment_id is not None:
        payload["comment_id"] = comment_id
    return payload


def _normalize_subtasks(subtasks: Optional[list[TodoSubtaskInput]]) -> list[dict]:
    normalized: list[dict] = []
    if not subtasks:
        return normalized
    if len(subtasks) > 100:
        raise HTTPException(422, "Too many subtasks")
    for index, subtask in enumerate(subtasks):
        title = sanitize_text(subtask.title or '').strip()
        if not title:
            continue
        if len(title) > 500:
            raise HTTPException(422, "Subtask title too long")
        normalized.append({
            'id': subtask.id,
            'title': title,
            'is_done': bool(subtask.is_done),
            'sort_order': subtask.sort_order if subtask.sort_order is not None else index,
        })
    return normalized


def _normalize_subtask_title(title: str) -> str:
    normalized = sanitize_text(title or '').strip()
    if not normalized:
        raise HTTPException(422, "Subtask title required")
    if len(normalized) > 500:
        raise HTTPException(422, "Subtask title too long")
    return normalized


def _subtask_count_for_todo(db, todo_id: int) -> int:
    row = db.execute("SELECT COUNT(*) AS count FROM todo_subtasks WHERE todo_id = ?", (todo_id,)).fetchone()
    return int(row['count'] if row else 0)


def _subtask_event_payload(db, todo_id: int, *, subtask: dict | None = None, subtask_id: int | None = None) -> dict:
    row = db.execute("SELECT updated_at FROM todos WHERE id = ?", (todo_id,)).fetchone()
    payload = {
        "todo_id": todo_id,
        "subtasks_count": _subtask_count_for_todo(db, todo_id),
        "updated_at": row['updated_at'] if row else now_iso(),
    }
    if subtask is not None:
        payload["subtask"] = subtask
    if subtask_id is not None:
        payload["subtask_id"] = subtask_id
    return payload


def _subtask_row(db, subtask_id: int) -> dict | None:
    row = db.execute(
        "SELECT id, todo_id, title, is_done, sort_order, created_at, updated_at FROM todo_subtasks WHERE id = ?",
        (subtask_id,),
    ).fetchone()
    return {**dict(row), 'is_done': bool(row['is_done'])} if row else None


def _replace_subtasks(db, todo_id: int, subtasks: list[dict]):
    db.execute("DELETE FROM todo_subtasks WHERE todo_id = ?", (todo_id,))
    now = now_iso()
    for index, subtask in enumerate(subtasks):
        db.execute(
            """INSERT INTO todo_subtasks (todo_id, title, is_done, sort_order, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (todo_id, subtask['title'], int(bool(subtask['is_done'])), subtask.get('sort_order', index), now, now)
        )


def _has_open_subtasks(subtasks: list[dict]) -> bool:
    return any(not bool(subtask.get('is_done')) for subtask in subtasks)


def fetch_todo(db, todo_id: int, reminder_user_id: Optional[int] = None) -> Optional[dict]:
    row = db.execute(
        """SELECT t.*, p.name as project_name, s.name as section_name
           FROM todos t
           LEFT JOIN projects p ON t.project_id = p.id
           LEFT JOIN sections s ON t.section_id = s.id
           WHERE t.id = ?""",
        (todo_id,)
    ).fetchone()
    if not row:
        return None
    d = row_to_dict(row)
    if reminder_user_id is None:
        rem_rows = db.execute(
            "SELECT id, remind_at, sent_at, COALESCE(source, 'explicit') AS source FROM reminders WHERE todo_id = ? ORDER BY remind_at",
            (todo_id,)
        ).fetchall()
    else:
        rem_rows = db.execute(
            """SELECT id, remind_at, sent_at, COALESCE(source, 'explicit') AS source FROM reminders
               WHERE todo_id = ? AND (user_id = ? OR user_id IS NULL)
               ORDER BY remind_at""",
            (todo_id, reminder_user_id)
        ).fetchall()
    d['reminders'] = [dict(r) for r in rem_rows]
    d['subtasks'] = _subtasks_for_todo(db, todo_id)
    d['comments'] = _comments_for_todo(db, todo_id)
    d['comments_count'] = len(d['comments'])
    d['attachments'] = _attachments_for_todo(db, todo_id)
    d['attachments_count'] = len(d['attachments'])
    d['location_reminders'] = _location_reminders_for_todo(db, todo_id, reminder_user_id)
    d['location_reminder'] = d['location_reminders'][0] if d['location_reminders'] else None
    return _recurring_rule_response(d)


def _todo_project_access(db, todo: dict, user_id: int) -> bool:
    project_id = todo.get('project_id')
    if project_id is None:
        return todo.get('user_id') == user_id
    return can_access_project(db, project_id, user_id) or todo.get('user_id') == user_id


def _todo_attachment_write_access(db, todo: dict, user_id: int) -> bool:
    project_id = todo.get('project_id')
    if project_id is None:
        return todo.get('user_id') == user_id
    return can_manage_todos(db, project_id, user_id) or todo.get('user_id') == user_id


def _require_attachment_readable_todo(db, todo_id: int, user_id: int) -> dict:
    todo = fetch_todo(db, todo_id, user_id)
    if not todo or not _todo_project_access(db, todo, user_id):
        raise HTTPException(404, "Todo not found")
    return todo


def _require_attachment_writable_todo(db, todo_id: int, user_id: int) -> dict:
    todo = fetch_todo(db, todo_id, user_id)
    if not todo or not _todo_attachment_write_access(db, todo, user_id):
        raise HTTPException(404, "Todo not found")
    return todo


async def _stream_attachment_to_temp(request: Request, tmp_path: Path) -> tuple[int, bytes]:
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_ATTACHMENT_BYTES:
                raise HTTPException(413, "Attachment is too large")
        except ValueError:
            raise HTTPException(400, "Invalid Content-Length")
    total = 0
    sample = bytearray()
    with tmp_path.open("wb") as handle:
        async for chunk in request.stream():
            if not chunk:
                continue
            total += len(chunk)
            if total > MAX_ATTACHMENT_BYTES:
                raise HTTPException(413, "Attachment is too large")
            if len(sample) < 512:
                sample.extend(chunk[:512 - len(sample)])
            handle.write(chunk)
    return total, bytes(sample)


def _validate_todo_target(db, project_id: Optional[int], section_id: Optional[int], user_id: int):
    if project_id is not None and not can_manage_todos(db, project_id, user_id):
        raise HTTPException(403, "Not authorized")
    if section_id is not None:
        row = db.execute("SELECT project_id FROM sections WHERE id = ?", (section_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Section not found")
        if project_id is None or row['project_id'] != project_id:
            raise HTTPException(400, "Section does not belong to the selected project")
        if not can_manage_todos(db, row['project_id'], user_id):
            raise HTTPException(403, "Not authorized")


def _validate_datetime(value: Optional[str], field_name: str):
    if value in (None, ""):
        return
    try:
        parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except ValueError:
        raise HTTPException(422, f"Invalid {field_name}")
    if parsed.year < 1900 or parsed.year > 9999:
        raise HTTPException(422, f"Invalid {field_name}")


def _validate_todo_dates(data):
    _validate_datetime(getattr(data, 'due_date', None), 'due_date')
    _validate_datetime(getattr(data, 'remind_at', None), 'remind_at')


def _validate_todo_status(status: Optional[str]):
    if status is not None and status not in ALLOWED_TODO_STATUSES:
        raise HTTPException(422, "Invalid status")


def _normalize_recurring_rule(rule: Optional[dict]) -> Optional[str]:
    if not rule:
        return None
    if not isinstance(rule, dict):
        raise HTTPException(422, "Invalid recurring_rule")
    frequency = str(rule.get('frequency') or '').strip().lower()
    if frequency in ('', 'none'):
        return None
    if frequency not in ALLOWED_RECURRENCE_FREQUENCIES:
        raise HTTPException(422, "Invalid recurring_rule frequency")
    try:
        interval = int(rule.get('interval') or 1)
    except (TypeError, ValueError):
        raise HTTPException(422, "Invalid recurring_rule interval")
    if interval < 1 or interval > 999:
        raise HTTPException(422, "Invalid recurring_rule interval")
    normalized = {
        "frequency": frequency,
        "interval": interval,
        "preserve_time": True,
    }
    timezone_name = str(rule.get('timezone') or '').strip()
    if timezone_name:
        if timezone_name not in ALLOWED_TIMEZONES:
            raise HTTPException(422, "Invalid recurring_rule timezone")
        try:
            ZoneInfo(timezone_name)
        except (ZoneInfoNotFoundError, ValueError):
            raise HTTPException(422, "Invalid recurring_rule timezone")
        normalized["timezone"] = timezone_name
    return json.dumps(normalized, separators=(',', ':'), sort_keys=True)


def _decode_recurring_rule(value) -> Optional[dict]:
    if not value:
        return None
    if isinstance(value, dict):
        return value
    try:
        data = json.loads(value)
    except (TypeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _last_day_of_month(year: int, month: int) -> int:
    return calendar.monthrange(year, month)[1]


def _add_months(dt: datetime, months: int) -> datetime:
    month_index = dt.month - 1 + months
    year = dt.year + month_index // 12
    month = month_index % 12 + 1
    day = min(dt.day, _last_day_of_month(year, month))
    return dt.replace(year=year, month=month, day=day)


def _wall_time_exists(dt: datetime) -> bool:
    if dt.tzinfo is None:
        return True
    roundtrip = dt.astimezone(timezone.utc).astimezone(dt.tzinfo)
    return (
        roundtrip.year == dt.year
        and roundtrip.month == dt.month
        and roundtrip.day == dt.day
        and roundtrip.hour == dt.hour
        and roundtrip.minute == dt.minute
        and roundtrip.second == dt.second
        and roundtrip.microsecond == dt.microsecond
    )


def _normalize_recurring_wall_datetime(dt: datetime) -> datetime:
    """Keep recurring schedules on wall-clock time across DST.

    Policy:
    - ambiguous fall-back folds use the first occurrence (fold=0)
    - nonexistent spring-forward gaps move to the next valid local minute
    """
    if dt.tzinfo is None:
        return dt
    candidate = dt.replace(fold=0)
    if _wall_time_exists(candidate):
        return candidate
    naive = candidate.replace(tzinfo=None)
    for minutes in range(1, 181):
        shifted = (naive + timedelta(minutes=minutes)).replace(tzinfo=dt.tzinfo, fold=0)
        if _wall_time_exists(shifted):
            return shifted
    return candidate.astimezone(timezone.utc).astimezone(dt.tzinfo).replace(fold=0)


def _next_recurring_datetime(value: Optional[str], rule: dict) -> Optional[str]:
    if not value:
        return None
    try:
        base = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except ValueError:
        return None
    interval = int(rule.get('interval') or 1)
    frequency = rule.get('frequency')
    timezone_name = str(rule.get('timezone') or '').strip()
    recurrence_tz = None
    if timezone_name:
        try:
            recurrence_tz = ZoneInfo(timezone_name)
        except (ZoneInfoNotFoundError, ValueError):
            recurrence_tz = None
    if recurrence_tz and base.tzinfo is not None:
        base = base.astimezone(recurrence_tz)
    if frequency == 'daily':
        next_dt = base + timedelta(days=interval)
    elif frequency == 'weekly':
        next_dt = base + timedelta(weeks=interval)
    elif frequency == 'monthly':
        next_dt = _add_months(base, interval)
    elif frequency == 'yearly':
        next_dt = _add_months(base, interval * 12)
    else:
        return None
    if recurrence_tz:
        next_dt = _normalize_recurring_wall_datetime(next_dt)
    return next_dt.isoformat()


def _recurring_rule_response(todo: dict) -> dict:
    if todo and isinstance(todo.get('recurring_rule'), str):
        todo['recurring_rule'] = _decode_recurring_rule(todo.get('recurring_rule'))
    return todo


def _user_default_reminder_offset_minutes(db, user_id: int) -> Optional[int]:
    try:
        row = db.execute("SELECT default_reminder_offset_minutes FROM users WHERE id = ?", (user_id,)).fetchone()
    except Exception:
        return None
    if not row or row['default_reminder_offset_minutes'] is None:
        return None
    try:
        offset = int(row['default_reminder_offset_minutes'])
    except (TypeError, ValueError):
        return None
    if offset < 0:
        return None
    return offset


def _default_reminder_at_for_due_date(db, user_id: int, due_date: Optional[str]) -> Optional[str]:
    if not due_date:
        return None
    offset = _user_default_reminder_offset_minutes(db, user_id)
    if offset is None:
        return None
    try:
        due_dt = datetime.fromisoformat(str(due_date).replace('Z', '+00:00'))
    except ValueError:
        return None
    return (due_dt - timedelta(minutes=offset)).isoformat()


def _datetime_values_equal(left: Optional[str], right: Optional[str]) -> bool:
    if left in (None, "") or right in (None, ""):
        return left == right
    if str(left) == str(right):
        return True
    try:
        left_dt = datetime.fromisoformat(str(left).replace('Z', '+00:00'))
        right_dt = datetime.fromisoformat(str(right).replace('Z', '+00:00'))
    except ValueError:
        return False
    return left_dt == right_dt


def _matches_existing_auto_due_reminder(existing: dict, remind_at: Optional[str]) -> bool:
    if not remind_at:
        return False
    for reminder in existing.get('reminders') or []:
        if reminder.get('source') == AUTO_REMINDER_SOURCE and _datetime_values_equal(reminder.get('remind_at'), remind_at):
            return True
    return False


def _insert_reminder(db, todo_id: int, remind_at: str, user_id: int, source: str = EXPLICIT_REMINDER_SOURCE):
    db.execute(
        "INSERT INTO reminders (todo_id, remind_at, user_id, source) VALUES (?,?,?,?)",
        (todo_id, remind_at, user_id, source),
    )


def _validate_location_reminder(db, data: Optional[dict], user_id: int) -> Optional[dict]:
    if not data:
        return None
    if not isinstance(data, dict):
        raise HTTPException(422, "Invalid location_reminder")
    forbidden_fields = sorted(field for field in FORBIDDEN_LOCATION_COORDINATE_FIELDS if field in data)
    if forbidden_fields:
        raise HTTPException(422, f"Location reminder does not accept coordinates or radius fields: {', '.join(forbidden_fields)}")
    trigger_type = str(data.get('trigger_type') or data.get('trigger') or '').strip().lower()
    if trigger_type not in ALLOWED_LOCATION_TRIGGERS:
        raise HTTPException(422, "Invalid location reminder trigger_type")

    place_id = data.get('place_id')
    if place_id not in (None, ''):
        try:
            place_id = int(place_id)
        except (TypeError, ValueError):
            raise HTTPException(422, "Invalid location reminder place_id")
        place = db.execute("SELECT * FROM saved_places WHERE id = ? AND user_id = ?", (place_id, user_id)).fetchone()
        if not place:
            raise HTTPException(404, "Place not found")
        address = sanitize_text(str(place['address'] or '')).strip()[:500]
    else:
        place_id = None
        address = sanitize_text(str(data.get('address') or '')).strip()[:500]

    if not address:
        raise HTTPException(422, "Location reminder address is required")

    return {
        'trigger_type': trigger_type,
        'place_id': place_id,
        'address': address,
        'enabled': 1 if data.get('enabled', True) is not False else 0,
        'source': sanitize_text(str(data.get('source') or EXPLICIT_REMINDER_SOURCE)).strip()[:40] or EXPLICIT_REMINDER_SOURCE,
    }

def _insert_location_reminder(db, todo_id: int, user_id: int, location: dict):
    now = now_iso()
    db.execute(
        """INSERT INTO location_reminders
           (todo_id, user_id, trigger_type, place_id, address, enabled, source, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (
            todo_id, user_id, location['trigger_type'], location.get('place_id'), location.get('address') or '',
            int(bool(location.get('enabled', 1))), location.get('source') or EXPLICIT_REMINDER_SOURCE, now, now,
        ),
    )


def _replace_location_reminder(db, todo_id: int, user_id: int, location_data: Optional[dict]):
    if location_data is None:
        db.execute("DELETE FROM location_reminders WHERE todo_id = ? AND user_id = ?", (todo_id, user_id))
        return
    location = _validate_location_reminder(db, location_data, user_id)
    if not location:
        db.execute("DELETE FROM location_reminders WHERE todo_id = ? AND user_id = ?", (todo_id, user_id))
        return
    db.execute("DELETE FROM location_reminders WHERE todo_id = ? AND user_id = ?", (todo_id, user_id))
    _insert_location_reminder(db, todo_id, user_id, location)


def _location_reminders_for_todo(db, todo_id: int, user_id: Optional[int] = None) -> list[dict]:
    try:
        if user_id is None:
            rows = db.execute(
                """SELECT lr.*, sp.name AS place_name, sp.icon AS place_icon
                   FROM location_reminders lr
                   LEFT JOIN saved_places sp ON lr.place_id = sp.id
                   WHERE lr.todo_id = ?
                   ORDER BY lr.id""",
                (todo_id,),
            ).fetchall()
        else:
            rows = db.execute(
                """SELECT lr.*, sp.name AS place_name, sp.icon AS place_icon
                   FROM location_reminders lr
                   LEFT JOIN saved_places sp ON lr.place_id = sp.id
                   WHERE lr.todo_id = ? AND lr.user_id = ?
                   ORDER BY lr.id""",
                (todo_id, user_id),
            ).fetchall()
    except Exception:
        return []
    return [dict(row) for row in rows]


def _sync_default_due_reminder(db, todo_id: int, user_id: int, due_date: Optional[str]):
    """Create/update the automatic due-date reminder without touching explicit reminders."""
    rows = db.execute(
        """SELECT id, COALESCE(source, 'explicit') AS source FROM reminders
           WHERE todo_id = ? AND (user_id = ? OR user_id IS NULL)""",
        (todo_id, user_id),
    ).fetchall()
    has_explicit = any(row['source'] != AUTO_REMINDER_SOURCE for row in rows)
    if has_explicit:
        return
    db.execute(
        "DELETE FROM reminders WHERE todo_id = ? AND (user_id = ? OR user_id IS NULL) AND COALESCE(source, 'explicit') = ?",
        (todo_id, user_id, AUTO_REMINDER_SOURCE),
    )
    remind_at = _default_reminder_at_for_due_date(db, user_id, due_date)
    if remind_at:
        _insert_reminder(db, todo_id, remind_at, user_id, AUTO_REMINDER_SOURCE)


# ─── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("")
def list_todos(status: Optional[str] = None, project_id: Optional[int] = None, section_id: Optional[int] = None, user_id: int = Depends(require_auth)):
    with get_db() as db:
        if project_id is not None and not can_access_project(db, project_id, user_id):
            raise HTTPException(404, "Project not found")
        if section_id is not None:
            section = db.execute("SELECT project_id FROM sections WHERE id = ?", (section_id,)).fetchone()
            if not section:
                raise HTTPException(404, "Section not found")
            if project_id is not None and section['project_id'] != project_id:
                raise HTTPException(400, "Section does not belong to the selected project")
            if not can_access_project(db, section['project_id'], user_id):
                raise HTTPException(404, "Section not found")

        project_ids = get_project_ids_for_user(db, user_id)
        params: list = []
        sql = """
            SELECT t.*, p.name as project_name, s.name as section_name FROM todos t
            LEFT JOIN projects p ON t.project_id = p.id
            LEFT JOIN sections s ON t.section_id = s.id
            WHERE t.status != 'archived'
        """
        if project_ids:
            placeholders = ','.join('?' for _ in project_ids)
            sql += f" AND (t.user_id = ? OR t.project_id IN ({placeholders}))"
            params.extend([user_id, *project_ids])
        else:
            sql += " AND t.user_id = ?"
            params.append(user_id)
        if status:
            sql += " AND t.status = ?"
            params.append(status)
        if project_id is not None:
            sql += " AND t.project_id = ?"
            params.append(project_id)
        if section_id is not None:
            sql += " AND t.section_id = ?"
            params.append(section_id)
        sql += " ORDER BY COALESCE(t.is_pinned, 0) DESC, CASE t.status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, t.priority, t.due_date IS NULL, t.due_date"
        rows = db.execute(sql, params).fetchall()
        todos = [row_to_dict(r) for r in rows]
        todo_ids = [todo['id'] for todo in todos]
        reminders_by_todo = {todo_id: [] for todo_id in todo_ids}
        subtasks_by_todo = {todo_id: [] for todo_id in todo_ids}
        comments_by_todo = {todo_id: [] for todo_id in todo_ids}
        attachments_by_todo = {todo_id: [] for todo_id in todo_ids}
        location_reminders_by_todo = {todo_id: [] for todo_id in todo_ids}
        if todo_ids:
            placeholders = ','.join('?' for _ in todo_ids)
            reminder_rows = db.execute(
                f"""SELECT id, todo_id, remind_at, sent_at, COALESCE(source, 'explicit') AS source FROM reminders
                   WHERE todo_id IN ({placeholders}) AND (user_id = ? OR user_id IS NULL)
                   ORDER BY remind_at""",
                [*todo_ids, user_id]
            ).fetchall()
            for reminder in reminder_rows:
                reminder_dict = dict(reminder)
                reminders_by_todo.setdefault(reminder_dict.pop('todo_id'), []).append(reminder_dict)
            subtask_rows = db.execute(
                f"""SELECT id, todo_id, title, is_done, sort_order, created_at, updated_at
                   FROM todo_subtasks
                   WHERE todo_id IN ({placeholders})
                   ORDER BY sort_order, id""",
                todo_ids
            ).fetchall()
            for subtask in subtask_rows:
                subtask_dict = dict(subtask)
                subtask_dict['is_done'] = bool(subtask_dict.get('is_done'))
                subtasks_by_todo.setdefault(subtask_dict.pop('todo_id'), []).append(subtask_dict)
            comment_rows = db.execute(
                f"""SELECT tc.id, tc.todo_id, tc.user_id, tc.body, tc.created_at, tc.updated_at,
                          u.username AS author_username, u.display_name AS author_display_name
                   FROM todo_comments tc
                   LEFT JOIN users u ON u.id = tc.user_id
                   WHERE tc.todo_id IN ({placeholders})
                   ORDER BY tc.created_at, tc.id""",
                todo_ids
            ).fetchall()
            for comment in comment_rows:
                comment_dict = dict(comment)
                comments_by_todo.setdefault(comment_dict.get('todo_id'), []).append(comment_dict)
            if _attachment_table_exists(db):
                attachment_rows = db.execute(
                    f"""SELECT ta.id, ta.todo_id, ta.user_id, ta.original_filename, ta.content_type, ta.size_bytes,
                              ta.created_at, u.username AS uploader_username, u.display_name AS uploader_display_name
                       FROM todo_attachments ta
                       LEFT JOIN users u ON u.id = ta.user_id
                       WHERE ta.todo_id IN ({placeholders})
                       ORDER BY ta.created_at, ta.id""",
                    todo_ids
                ).fetchall()
                for attachment in attachment_rows:
                    attachment_dict = dict(attachment)
                    attachments_by_todo.setdefault(attachment_dict.get('todo_id'), []).append(attachment_dict)
            try:
                location_rows = db.execute(
                    f"""SELECT lr.*, sp.name AS place_name, sp.icon AS place_icon FROM location_reminders lr
                       LEFT JOIN saved_places sp ON lr.place_id = sp.id
                       WHERE lr.todo_id IN ({placeholders}) AND lr.user_id = ?
                       ORDER BY lr.id""",
                    [*todo_ids, user_id]
                ).fetchall()
            except Exception:
                location_rows = []
            for location_reminder in location_rows:
                location_dict = dict(location_reminder)
                location_reminders_by_todo.setdefault(location_dict.pop('todo_id'), []).append(location_dict)
        for todo in todos:
            todo['reminders'] = reminders_by_todo.get(todo['id'], [])
            todo['subtasks'] = subtasks_by_todo.get(todo['id'], [])
            todo['comments'] = comments_by_todo.get(todo['id'], [])
            todo['comments_count'] = len(todo['comments'])
            todo['attachments'] = attachments_by_todo.get(todo['id'], [])
            todo['attachments_count'] = len(todo['attachments'])
            todo['location_reminders'] = location_reminders_by_todo.get(todo['id'], [])
            todo['location_reminder'] = todo['location_reminders'][0] if todo['location_reminders'] else None
            _recurring_rule_response(todo)
        return {"todos": todos}

@router.post("")
async def create_todo(data: TodoCreate, user_id: int = Depends(require_auth)):
    data.title = sanitize_text(data.title)
    data.description = sanitize_text(data.description)
    _validate_todo_dates(data)
    _validate_todo_status(data.status)
    subtasks = _normalize_subtasks(data.subtasks)
    if data.status == 'done' and _has_open_subtasks(subtasks) and not data.confirm_incomplete_subtasks_completion:
        raise HTTPException(409, "Cannot complete todo with open subtasks without confirmation")
    with get_db() as db:
        if data.project_id is None and data.section_id is None:
            data.project_id = get_user_inbox_project_id(db, user_id)
        _validate_todo_target(db, data.project_id, data.section_id, user_id)
        now = now_iso()
        completed_at = now if data.status == 'done' else None
        recurring_rule = _normalize_recurring_rule(data.recurring_rule)
        if recurring_rule and not data.due_date:
            raise HTTPException(422, "Recurring todos require due_date")
        c = db.execute(
            """INSERT INTO todos
               (title, description, priority, is_pinned, status, project_id, section_id, due_date, completed_at, recurring_rule, updated_at, user_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (data.title, data.description, data.priority, int(bool(data.is_pinned)), data.status, data.project_id, data.section_id, data.due_date, completed_at, recurring_rule, now, user_id)
        )
        todo_id = c.lastrowid
        if subtasks:
            _replace_subtasks(db, todo_id, subtasks)
        if data.remind_at:
            _insert_reminder(db, todo_id, data.remind_at, user_id, EXPLICIT_REMINDER_SOURCE)
        else:
            _sync_default_due_reminder(db, todo_id, user_id, data.due_date)
        location = _validate_location_reminder(db, data.location_reminder, user_id)
        if location:
            _insert_location_reminder(db, todo_id, user_id, location)
        db.commit()
        todo = fetch_todo(db, todo_id, user_id)
        await broadcast_change("todo_create", todo, user_id, data.project_id)
        return todo

@router.get("/{todo_id}")
def get_todo(todo_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        d = fetch_todo(db, todo_id, user_id)
        if not d:
            raise HTTPException(404, "Todo not found")
        if not _todo_project_access(db, d, user_id):
            raise HTTPException(403, "Not authorized")
        return d

@router.patch("/{todo_id}")
async def update_todo(todo_id: int, data: TodoUpdate, user_id: int = Depends(require_auth)):
    if data.title is not None:
        data.title = sanitize_text(data.title)
    if data.description is not None:
        data.description = sanitize_text(data.description)
    _validate_todo_dates(data)
    _validate_todo_status(data.status)
    subtasks_update = _normalize_subtasks(data.subtasks) if data.subtasks is not None else None
    with get_db() as db:
        existing = fetch_todo(db, todo_id, user_id)
        if not existing:
            raise HTTPException(404, "Todo not found")
        if not _todo_project_access(db, existing, user_id):
            raise HTTPException(403, "Not authorized")
        dumped = data.model_dump(exclude_unset=True)
        effective_subtasks = subtasks_update if subtasks_update is not None else existing.get('subtasks', [])
        if dumped.get('status') == 'done' and existing.get('status') != 'done' and _has_open_subtasks(effective_subtasks) and not data.confirm_incomplete_subtasks_completion:
            raise HTTPException(409, "Cannot complete todo with open subtasks without confirmation")
        target_project_id = dumped.get('project_id', existing.get('project_id'))
        target_section_id = dumped.get('section_id', existing.get('section_id'))
        _validate_todo_target(db, target_project_id, target_section_id, user_id)

        updates = {}
        for f in ["title", "description", "priority", "is_pinned", "project_id", "section_id", "due_date", "status"]:
            if f in dumped:
                updates[f] = dumped[f]
        if 'recurring_rule' in dumped:
            updates['recurring_rule'] = _normalize_recurring_rule(dumped.get('recurring_rule'))
        effective_due_date = dumped.get('due_date', existing.get('due_date'))
        effective_recurring_rule = updates.get('recurring_rule', existing.get('recurring_rule')) if updates else existing.get('recurring_rule')
        if effective_recurring_rule and not effective_due_date:
            raise HTTPException(422, "Recurring todos require due_date")
        if updates:
            updates['updated_at'] = now_iso()
            if data.status == 'done' and existing['status'] != 'done':
                updates['completed_at'] = now_iso()
            elif data.status is not None and data.status != 'done' and existing['status'] == 'done':
                updates['completed_at'] = None
            if 'is_pinned' in updates:
                updates['is_pinned'] = int(bool(updates['is_pinned']))
            allowed_cols = {"title", "description", "priority", "is_pinned", "project_id", "section_id", "due_date", "status", "completed_at", "updated_at", "recurring_rule"}
            safe_updates = {k:v for k,v in updates.items() if k in allowed_cols}
            set_clause = ", ".join(f"{k}=:{k}" for k in safe_updates)
            db.execute(f"UPDATE todos SET {set_clause} WHERE id = :id", {**safe_updates, "id": todo_id})
        if subtasks_update is not None:
            _replace_subtasks(db, todo_id, subtasks_update)
            db.execute("UPDATE todos SET updated_at = ? WHERE id = ?", (now_iso(), todo_id))
        due_date_changed = 'due_date' in dumped and dumped.get('due_date') != existing.get('due_date')
        remind_at_is_existing_auto_default = _matches_existing_auto_due_reminder(existing, data.remind_at)
        if 'remind_at' in dumped:
            if remind_at_is_existing_auto_default:
                if due_date_changed:
                    _sync_default_due_reminder(db, todo_id, user_id, effective_due_date)
            else:
                if existing.get('user_id') == user_id:
                    db.execute(
                        "DELETE FROM reminders WHERE todo_id = ? AND (user_id = ? OR user_id IS NULL)",
                        (todo_id, user_id)
                    )
                else:
                    db.execute("DELETE FROM reminders WHERE todo_id = ? AND user_id = ?", (todo_id, user_id))
                if data.remind_at:
                    _insert_reminder(db, todo_id, data.remind_at, user_id, EXPLICIT_REMINDER_SOURCE)
                elif due_date_changed:
                    _sync_default_due_reminder(db, todo_id, user_id, effective_due_date)
        elif due_date_changed:
            _sync_default_due_reminder(db, todo_id, user_id, effective_due_date)
        if 'location_reminder' in dumped:
            _replace_location_reminder(db, todo_id, user_id, dumped.get('location_reminder'))
            db.execute("UPDATE todos SET updated_at = ? WHERE id = ?", (now_iso(), todo_id))
        recurrence_created_todo = None
        recurrence_inserted = False
        normalized_existing_rule = existing.get('recurring_rule')
        if isinstance(normalized_existing_rule, dict):
            normalized_existing_rule = json.dumps(normalized_existing_rule, separators=(',', ':'), sort_keys=True)
        effective_rule = updates.get('recurring_rule', normalized_existing_rule) if updates else normalized_existing_rule
        rule = _decode_recurring_rule(effective_rule)
        became_done = dumped.get('status') == 'done' and existing.get('status') != 'done'
        recurrence_series_parent_id = existing.get('parent_id') or todo_id
        recurrence_existing_next_id = None
        if became_done and rule:
            next_due_date = _next_recurring_datetime(updates.get('due_date', existing.get('due_date')), rule)
            existing_reminder = (existing.get('reminders') or [{}])[0]
            reminder_source = existing_reminder.get('source') or EXPLICIT_REMINDER_SOURCE
            if remind_at_is_existing_auto_default:
                reminder_source = AUTO_REMINDER_SOURCE
            if reminder_source == AUTO_REMINDER_SOURCE:
                next_remind_at = _default_reminder_at_for_due_date(db, user_id, next_due_date)
            else:
                reminder_base = data.remind_at or existing_reminder.get('remind_at')
                next_remind_at = _next_recurring_datetime(reminder_base, rule)
            if next_due_date or next_remind_at:
                existing_next = db.execute(
                    """SELECT id FROM todos
                       WHERE parent_id = ?
                         AND user_id = ?
                         AND COALESCE(due_date, '') = COALESCE(?, '')
                         AND status != 'archived'
                       ORDER BY id LIMIT 1""",
                    (recurrence_series_parent_id, user_id, next_due_date)
                ).fetchone()
                if existing_next:
                    recurrence_existing_next_id = existing_next['id']
                else:
                    now_next = now_iso()
                    c = db.execute(
                        """INSERT INTO todos
                           (title, description, priority, is_pinned, status, project_id, section_id, due_date, completed_at, recurring_rule, parent_id, updated_at, user_id)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (updates.get('title', existing.get('title')), updates.get('description', existing.get('description') or ''), updates.get('priority', existing.get('priority')), int(bool(updates.get('is_pinned', existing.get('is_pinned')))), 'pending', target_project_id, target_section_id, next_due_date, None, effective_rule, recurrence_series_parent_id, now_next, user_id)
                    )
                    recurrence_existing_next_id = c.lastrowid
                    recurrence_inserted = True
                    if effective_subtasks:
                        _replace_subtasks(
                            db,
                            recurrence_existing_next_id,
                            [{**subtask, 'id': None, 'is_done': False} for subtask in effective_subtasks]
                        )
                    if next_remind_at:
                        _insert_reminder(db, recurrence_existing_next_id, next_remind_at, user_id, reminder_source)
        db.commit()
        todo = fetch_todo(db, todo_id, user_id)
        if became_done and rule and recurrence_existing_next_id:
            recurrence_created_todo = fetch_todo(db, recurrence_existing_next_id, user_id)
            todo['recurrence_created_todo'] = recurrence_created_todo
        broadcast_todo = dict(todo)
        broadcast_todo.pop('recurrence_created_todo', None)
        await broadcast_change("todo_update", broadcast_todo, user_id, todo.get('project_id'))
        if recurrence_created_todo and recurrence_inserted:
            await broadcast_change("todo_create", recurrence_created_todo, user_id, recurrence_created_todo.get('project_id'))
        return todo


@router.post("/{todo_id}/subtasks")
async def create_todo_subtask(todo_id: int, data: TodoSubtaskCreate, user_id: int = Depends(require_auth)):
    with get_db() as db:
        todo = fetch_todo(db, todo_id, user_id)
        if not todo or not _todo_project_access(db, todo, user_id):
            raise HTTPException(404, "Todo not found")
        title = _normalize_subtask_title(data.title)
        now = now_iso()
        sort_order = data.sort_order
        if sort_order is None:
            row = db.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order FROM todo_subtasks WHERE todo_id = ?", (todo_id,)).fetchone()
            sort_order = int(row['next_sort_order'] if row else 0)
        cursor = db.execute(
            """INSERT INTO todo_subtasks (todo_id, title, is_done, sort_order, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (todo_id, title, int(bool(data.is_done)), sort_order, now, now),
        )
        db.execute("UPDATE todos SET updated_at = ? WHERE id = ?", (now, todo_id))
        db.commit()
        subtask = _subtask_row(db, cursor.lastrowid)
        updated_todo = fetch_todo(db, todo_id, user_id)
        await broadcast_change("todo_subtask_create", _subtask_event_payload(db, todo_id, subtask=subtask), user_id, updated_todo.get('project_id'))
        return {"subtask": subtask, "todo": updated_todo}


@router.patch("/{todo_id}/subtasks/{subtask_id}")
async def update_todo_subtask(todo_id: int, subtask_id: int, data: TodoSubtaskUpdate, user_id: int = Depends(require_auth)):
    with get_db() as db:
        todo = fetch_todo(db, todo_id, user_id)
        if not todo or not _todo_project_access(db, todo, user_id):
            raise HTTPException(404, "Todo not found")
        existing = _subtask_row(db, subtask_id)
        if not existing or int(existing['todo_id']) != int(todo_id):
            raise HTTPException(404, "Subtask not found")
        updates = {}
        if data.title is not None:
            updates['title'] = _normalize_subtask_title(data.title)
        if data.is_done is not None:
            updates['is_done'] = int(bool(data.is_done))
        if data.sort_order is not None:
            updates['sort_order'] = int(data.sort_order)
        if not updates:
            return {"subtask": existing, "todo": todo}
        now = now_iso()
        updates['updated_at'] = now
        set_clause = ', '.join(f"{field} = ?" for field in updates.keys())
        db.execute(f"UPDATE todo_subtasks SET {set_clause} WHERE id = ?", (*updates.values(), subtask_id))
        db.execute("UPDATE todos SET updated_at = ? WHERE id = ?", (now, todo_id))
        db.commit()
        subtask = _subtask_row(db, subtask_id)
        updated_todo = fetch_todo(db, todo_id, user_id)
        await broadcast_change("todo_subtask_update", _subtask_event_payload(db, todo_id, subtask=subtask), user_id, updated_todo.get('project_id'))
        return {"subtask": subtask, "todo": updated_todo}


@router.delete("/{todo_id}/subtasks/{subtask_id}")
async def delete_todo_subtask(todo_id: int, subtask_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        todo = fetch_todo(db, todo_id, user_id)
        if not todo or not _todo_project_access(db, todo, user_id):
            raise HTTPException(404, "Todo not found")
        existing = _subtask_row(db, subtask_id)
        if not existing or int(existing['todo_id']) != int(todo_id):
            raise HTTPException(404, "Subtask not found")
        now = now_iso()
        db.execute("DELETE FROM todo_subtasks WHERE id = ?", (subtask_id,))
        db.execute("UPDATE todos SET updated_at = ? WHERE id = ?", (now, todo_id))
        db.commit()
        updated_todo = fetch_todo(db, todo_id, user_id)
        await broadcast_change("todo_subtask_delete", _subtask_event_payload(db, todo_id, subtask_id=subtask_id), user_id, updated_todo.get('project_id'))
        return {"deleted": subtask_id, "todo": updated_todo}


@router.post("/{todo_id}/comments")
async def create_todo_comment(todo_id: int, data: TodoCommentCreate, user_id: int = Depends(require_auth)):
    body = _normalize_comment_body(data.body)
    with get_db() as db:
        existing = fetch_todo(db, todo_id, user_id)
        if not existing:
            raise HTTPException(404, "Todo not found")
        if not _todo_project_access(db, existing, user_id):
            raise HTTPException(403, "Not authorized")
        now = now_iso()
        cursor = db.execute(
            """INSERT INTO todo_comments (todo_id, user_id, body, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?)""",
            (todo_id, user_id, body, now, now)
        )
        db.execute("UPDATE todos SET updated_at = ? WHERE id = ?", (now, todo_id))
        db.commit()
        comment = dict(db.execute(
            """SELECT tc.id, tc.todo_id, tc.user_id, tc.body, tc.created_at, tc.updated_at,
                      u.username AS author_username, u.display_name AS author_display_name
               FROM todo_comments tc
               LEFT JOIN users u ON u.id = tc.user_id
               WHERE tc.id = ?""",
            (cursor.lastrowid,)
        ).fetchone())
        todo = fetch_todo(db, todo_id, user_id)
        await broadcast_change("todo_comment_create", _comment_event_payload(db, todo_id, comment=comment), user_id, todo.get('project_id'))
        return {"comment": comment, "todo": todo}


@router.patch("/{todo_id}/comments/{comment_id}")
async def update_todo_comment(todo_id: int, comment_id: int, data: TodoCommentUpdate, user_id: int = Depends(require_auth)):
    body = _normalize_comment_body(data.body)
    with get_db() as db:
        existing = fetch_todo(db, todo_id, user_id)
        if not existing:
            raise HTTPException(404, "Todo not found")
        if not _todo_project_access(db, existing, user_id):
            raise HTTPException(403, "Not authorized")
        comment = db.execute("SELECT * FROM todo_comments WHERE id = ? AND todo_id = ?", (comment_id, todo_id)).fetchone()
        if not comment:
            raise HTTPException(404, "Comment not found")
        if comment['user_id'] != user_id:
            raise HTTPException(403, "Not authorized")
        now = now_iso()
        db.execute("UPDATE todo_comments SET body = ?, updated_at = ? WHERE id = ?", (body, now, comment_id))
        db.execute("UPDATE todos SET updated_at = ? WHERE id = ?", (now, todo_id))
        db.commit()
        updated = dict(db.execute(
            """SELECT tc.id, tc.todo_id, tc.user_id, tc.body, tc.created_at, tc.updated_at,
                      u.username AS author_username, u.display_name AS author_display_name
               FROM todo_comments tc
               LEFT JOIN users u ON u.id = tc.user_id
               WHERE tc.id = ?""",
            (comment_id,)
        ).fetchone())
        todo = fetch_todo(db, todo_id, user_id)
        await broadcast_change("todo_comment_update", _comment_event_payload(db, todo_id, comment=updated), user_id, todo.get('project_id'))
        return {"comment": updated, "todo": todo}


@router.delete("/{todo_id}/comments/{comment_id}")
async def delete_todo_comment(todo_id: int, comment_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        existing = fetch_todo(db, todo_id, user_id)
        if not existing:
            raise HTTPException(404, "Todo not found")
        if not _todo_project_access(db, existing, user_id):
            raise HTTPException(403, "Not authorized")
        comment = db.execute("SELECT * FROM todo_comments WHERE id = ? AND todo_id = ?", (comment_id, todo_id)).fetchone()
        if not comment:
            raise HTTPException(404, "Comment not found")
        if comment['user_id'] != user_id and existing.get('user_id') != user_id:
            raise HTTPException(403, "Not authorized")
        now = now_iso()
        db.execute("DELETE FROM todo_comments WHERE id = ?", (comment_id,))
        db.execute("UPDATE todos SET updated_at = ? WHERE id = ?", (now, todo_id))
        db.commit()
        todo = fetch_todo(db, todo_id, user_id)
        await broadcast_change("todo_comment_delete", _comment_event_payload(db, todo_id, comment_id=comment_id), user_id, todo.get('project_id'))
        return {"deleted": comment_id, "todo": todo}


@router.get("/attachments/usage")
def get_attachment_usage(user_id: int = Depends(require_auth)):
    with get_db() as db:
        return attachment_usage_payload(db, user_id)


@router.get("/{todo_id}/attachments")
def list_todo_attachments(todo_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        _require_attachment_readable_todo(db, todo_id, user_id)
        return {"attachments": _attachments_for_todo(db, todo_id)}


@router.post("/{todo_id}/attachments")
async def upload_todo_attachment(todo_id: int, request: Request, user_id: int = Depends(require_auth)):
    content_type = (request.headers.get("content-type") or "application/octet-stream").split(";", 1)[0].strip().lower() or "application/octet-stream"
    original_filename = _safe_attachment_filename(
        request.headers.get("x-nia-filename") or request.headers.get("x-file-name") or request.headers.get("x-filename")
    )
    suffix = Path(original_filename).suffix[:20]
    stored_filename = f"{secrets.token_hex(16)}{suffix}"
    target_path = _stored_attachment_path(todo_id, stored_filename)
    target_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = target_path.with_suffix(target_path.suffix + f".{secrets.token_hex(6)}.tmp")
    try:
        with get_db() as db:
            todo = _require_attachment_writable_todo(db, todo_id, user_id)
        size_bytes, sample = await _stream_attachment_to_temp(request, tmp_path)
        if size_bytes <= 0:
            raise HTTPException(400, "Attachment is required")
        detected_content_type = sniff_attachment_content_type(sample)
        with get_db() as db:
            todo = _require_attachment_writable_todo(db, todo_id, user_id)
            db.commit()
            db.execute("BEGIN IMMEDIATE")
            policy = enforce_attachment_upload_policy(
                db,
                user_id=user_id,
                filename=original_filename,
                content_type=content_type,
                size_bytes=size_bytes,
                detected_content_type=detected_content_type,
            )
            current_count = _attachment_count_for_todo(db, todo_id)
            if current_count >= MAX_ATTACHMENTS_PER_TODO:
                raise HTTPException(422, "Too many attachments")
            tmp_path.replace(target_path)
            now = now_iso()
            try:
                cursor = db.execute(
                    """INSERT INTO todo_attachments
                       (todo_id, user_id, original_filename, stored_filename, content_type, size_bytes, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (todo_id, user_id, original_filename, stored_filename, policy["content_type"], size_bytes, now),
                )
                db.execute("UPDATE todos SET updated_at = ? WHERE id = ?", (now, todo_id))
                db.commit()
            except Exception:
                try:
                    target_path.unlink(missing_ok=True)
                finally:
                    raise
            attachment = _public_attachment(_attachment_row(db, cursor.lastrowid))
            updated_todo = fetch_todo(db, todo_id, user_id)
            await broadcast_change("todo_attachment_create", _attachment_event_payload(db, todo_id, attachment=attachment), user_id, updated_todo.get('project_id'))
            return {"attachment": attachment, "todo": updated_todo, "usage": attachment_usage_payload(db, user_id)}
    finally:
        tmp_path.unlink(missing_ok=True)


@router.get("/{todo_id}/attachments/{attachment_id}/download")
def download_todo_attachment(todo_id: int, attachment_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        _require_attachment_readable_todo(db, todo_id, user_id)
        attachment = _attachment_row(db, attachment_id)
        if not attachment or int(attachment['todo_id']) != int(todo_id):
            raise HTTPException(404, "Attachment not found")
        path = _stored_attachment_path(todo_id, attachment['stored_filename'])
        if not path.exists() or not path.is_file():
            raise HTTPException(404, "Attachment file not found")
        filename = attachment.get('original_filename') or 'attachment'
        encoded = quote(filename)
        return FileResponse(
            str(path),
            media_type=attachment.get('content_type') or 'application/octet-stream',
            filename=filename,
            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded}"},
        )


@router.delete("/{todo_id}/attachments/{attachment_id}")
async def delete_todo_attachment(todo_id: int, attachment_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        todo = _require_attachment_writable_todo(db, todo_id, user_id)
        attachment = _attachment_row(db, attachment_id)
        if not attachment or int(attachment['todo_id']) != int(todo_id):
            raise HTTPException(404, "Attachment not found")
        now = now_iso()
        db.execute("DELETE FROM todo_attachments WHERE id = ?", (attachment_id,))
        db.execute("UPDATE todos SET updated_at = ? WHERE id = ?", (now, todo_id))
        db.commit()
        path = _stored_attachment_path(todo_id, attachment['stored_filename'])
        path.unlink(missing_ok=True)
        updated_todo = fetch_todo(db, todo_id, user_id)
        await broadcast_change("todo_attachment_delete", _attachment_event_payload(db, todo_id, attachment_id=attachment_id), user_id, updated_todo.get('project_id'))
        return {"deleted": attachment_id, "todo": updated_todo}

@router.delete("/{todo_id}")
async def delete_todo(todo_id: int, user_id: int = Depends(require_auth)):
    with get_db() as db:
        existing = fetch_todo(db, todo_id, user_id)
        if not existing:
            raise HTTPException(404, "Todo not found")
        if not _todo_project_access(db, existing, user_id):
            raise HTTPException(403, "Not authorized")
        db.execute("DELETE FROM todos WHERE id = ?", (todo_id,))
        db.commit()
        shutil.rmtree(ATTACHMENT_DIR / str(todo_id), ignore_errors=True)
        await broadcast_change("todo_delete", {"id": todo_id}, user_id, existing.get('project_id'))
        return {"deleted": todo_id}
