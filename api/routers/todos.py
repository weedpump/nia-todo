"""nia-todo: Todo endpoints"""

import calendar
import json
from datetime import datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError, available_timezones
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field

from db import get_db, row_to_dict, now_iso
from routers.auth import require_auth
from services.websocket import broadcast_change
from services.utils import sanitize_text
from services.sharing import can_access_project, can_manage_todos, get_project_ids_for_user

router = APIRouter(prefix="/api/todos")


# ─── Pydantic Models ─────────────────────────────────────────────────────────

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


def get_user_inbox_project_id(db, user_id: int) -> Optional[int]:
    row = db.execute(
        "SELECT id FROM projects WHERE user_id = ? AND COALESCE(is_inbox, 0) = 1 ORDER BY id LIMIT 1",
        (user_id,)
    ).fetchone()
    return row['id'] if row else None

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
    d['location_reminders'] = _location_reminders_for_todo(db, todo_id, reminder_user_id)
    d['location_reminder'] = d['location_reminders'][0] if d['location_reminders'] else None
    return _recurring_rule_response(d)


def _todo_project_access(db, todo: dict, user_id: int) -> bool:
    project_id = todo.get('project_id')
    if project_id is None:
        return todo.get('user_id') == user_id
    return can_access_project(db, project_id, user_id) or todo.get('user_id') == user_id


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
    with get_db() as db:
        existing = fetch_todo(db, todo_id, user_id)
        if not existing:
            raise HTTPException(404, "Todo not found")
        if not _todo_project_access(db, existing, user_id):
            raise HTTPException(403, "Not authorized")
        dumped = data.model_dump(exclude_unset=True)
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
        await broadcast_change("todo_delete", {"id": todo_id}, user_id, existing.get('project_id'))
        return {"deleted": todo_id}
