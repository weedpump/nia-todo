"""nia-todo: WebSocket endpoint handler"""

import asyncio
import json
from fastapi import WebSocket

from db import get_db, row_to_dict, now_iso
from services.auth import get_current_user
from services.entity_access import get_user_household
from services.sharing import get_project_ids_for_user, get_todo_reminder_recipient_user_id
from services.server_updates import get_public_update_status
from services.websocket import manager, get_project_view_for_user
from services.workspace_visibility import workspace_payload
from rate_limit import rate_limiter, get_client_ip_ws


def get_sync_todo_rows(db, user_id: int):
    """Return only todos currently reachable through personal or project access."""
    project_ids = get_project_ids_for_user(db, user_id)
    params = []
    todos_sql = """
        SELECT t.*, p.name as project_name, s.name as section_name FROM todos t
        LEFT JOIN projects p ON t.project_id = p.id
        LEFT JOIN sections s ON t.section_id = s.id
        WHERE t.status != 'archived'
    """
    if project_ids:
        placeholders = ','.join('?' for _ in project_ids)
        todos_sql += f" AND ((t.project_id IS NULL AND t.user_id = ?) OR t.project_id IN ({placeholders}))"
        params.extend([user_id, *project_ids])
    else:
        todos_sql += " AND t.project_id IS NULL AND t.user_id = ?"
        params.append(user_id)
    todos_sql += " ORDER BY CASE t.status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, t.priority, t.due_date IS NULL, t.due_date"
    return db.execute(todos_sql, params).fetchall()


def get_sync_todo_payloads(db, user_id: int) -> list[dict]:
    """Build recipient-specific todo snapshots for WebSocket sync."""
    todos_rows = get_sync_todo_rows(db, user_id)
    todo_ids = [row["id"] for row in todos_rows]
    subtasks_by_todo = {todo_id: [] for todo_id in todo_ids}
    comments_by_todo = {todo_id: [] for todo_id in todo_ids}
    attachments_by_todo = {todo_id: [] for todo_id in todo_ids}
    if todo_ids:
        placeholders = ",".join("?" for _ in todo_ids)
        subtask_rows = db.execute(
            f"""SELECT id, todo_id, title, is_done, sort_order, created_at, updated_at
                FROM todo_subtasks
                WHERE todo_id IN ({placeholders})
                ORDER BY sort_order, id""",
            todo_ids,
        ).fetchall()
        for subtask in subtask_rows:
            subtask_dict = row_to_dict(subtask)
            if subtask_dict is None:
                continue
            subtask_dict["is_done"] = bool(subtask_dict.get("is_done"))
            subtasks_by_todo.setdefault(subtask_dict.pop("todo_id"), []).append(subtask_dict)
        comment_rows = db.execute(
            f"""SELECT tc.id, tc.todo_id, tc.user_id, tc.body, tc.created_at, tc.updated_at,
                       u.username AS author_username, u.display_name AS author_display_name
                FROM todo_comments tc
                LEFT JOIN users u ON u.id = tc.user_id
                WHERE tc.todo_id IN ({placeholders})
                ORDER BY tc.created_at, tc.id""",
            todo_ids,
        ).fetchall()
        for comment in comment_rows:
            comment_dict = dict(comment)
            comments_by_todo.setdefault(comment_dict.get("todo_id"), []).append(comment_dict)
        attachment_rows = db.execute(
            f"""SELECT ta.id, ta.todo_id, ta.user_id, ta.original_filename, ta.content_type,
                       ta.size_bytes, ta.created_at,
                       u.username AS uploader_username, u.display_name AS uploader_display_name
                FROM todo_attachments ta
                LEFT JOIN users u ON u.id = ta.user_id
                WHERE ta.todo_id IN ({placeholders})
                ORDER BY ta.created_at, ta.id""",
            todo_ids,
        ).fetchall()
        for attachment in attachment_rows:
            attachment_dict = dict(attachment)
            attachments_by_todo.setdefault(attachment_dict.get("todo_id"), []).append(attachment_dict)

    todos_out = []
    for row in todos_rows:
        todo = row_to_dict(row)
        if todo is None:
            continue
        if isinstance(todo.get("recurring_rule"), str):
            try:
                recurring_rule = json.loads(todo["recurring_rule"])
            except (TypeError, ValueError):
                recurring_rule = None
            todo["recurring_rule"] = recurring_rule if isinstance(recurring_rule, dict) else None
        reminder_rows = db.execute(
            """SELECT id, user_id AS reminder_user_id, remind_at, sent_at FROM reminders
               WHERE todo_id = ? AND (user_id = ? OR user_id IS NULL)
               ORDER BY remind_at""",
            (todo["id"], user_id),
        ).fetchall()
        reminders = []
        for reminder in reminder_rows:
            reminder_dict = dict(reminder)
            reminder_owner_id = reminder_dict.pop("reminder_user_id")
            if reminder_owner_id is None and get_todo_reminder_recipient_user_id(db, todo) != user_id:
                continue
            reminders.append(reminder_dict)
        location_rows = db.execute(
            """SELECT lr.*, sp.name AS place_name, sp.icon AS place_icon
               FROM location_reminders lr
               LEFT JOIN saved_places sp ON lr.place_id = sp.id
               WHERE lr.todo_id = ? AND lr.user_id = ?
               ORDER BY lr.id""",
            (todo["id"], user_id),
        ).fetchall()
        todo["reminders"] = reminders
        todo["subtasks"] = subtasks_by_todo.get(todo["id"], [])
        todo["comments"] = comments_by_todo.get(todo["id"], [])
        todo["comments_count"] = len(todo["comments"])
        todo["attachments"] = attachments_by_todo.get(todo["id"], [])
        todo["attachments_count"] = len(todo["attachments"])
        todo["location_reminders"] = [dict(location) for location in location_rows]
        todo["location_reminder"] = todo["location_reminders"][0] if todo["location_reminders"] else None
        todos_out.append(todo)
    return todos_out


def get_sync_payload(db, user_id: int) -> dict:
    """Build the same recipient-specific snapshot used by an explicit sync request."""
    project_ids = get_project_ids_for_user(db, user_id)
    projects = [get_project_view_for_user(db, project_id, user_id) for project_id in project_ids]
    projects = [project for project in projects if project is not None]
    if project_ids:
        placeholders = ",".join("?" for _ in project_ids)
        sections_rows = db.execute(
            f"SELECT * FROM sections WHERE project_id IN ({placeholders}) ORDER BY sort_order, id",
            tuple(project_ids),
        ).fetchall()
    else:
        sections_rows = []
    workspaces_rows = db.execute(
        "SELECT * FROM workspaces WHERE user_id = ? ORDER BY COALESCE(is_default, 0) DESC, sort_order, name, id",
        (user_id,),
    ).fetchall()
    household = get_user_household(db, user_id)
    household_payload = None
    if household:
        household_payload = dict(household)
        owner = db.execute(
            "SELECT username, display_name FROM users WHERE id = ?",
            (household["owner_user_id"],),
        ).fetchone()
        household_payload["owner_username"] = owner["username"] if owner else None
        household_payload["owner_display_name"] = owner["display_name"] if owner else None
        statuses = ("pending", "accepted") if household["owner_user_id"] == user_id else ("accepted",)
        placeholders = ",".join("?" for _ in statuses)
        member_rows = db.execute(
            f"""SELECT hm.id, hm.user_id, hm.status, hm.created_at, hm.updated_at,
                       u.username, u.display_name
                FROM household_members hm
                JOIN users u ON u.id = hm.user_id
                WHERE hm.household_id = ? AND hm.status IN ({placeholders})
                ORDER BY CASE hm.status WHEN 'accepted' THEN 0 ELSE 1 END, u.username""",
            (household["id"], *statuses),
        ).fetchall()
        household_payload["members"] = [dict(row) for row in member_rows]
    household_invite_rows = db.execute(
        """SELECT hm.id, hm.household_id, hm.status, hm.created_at, hm.updated_at,
                  h.name AS household_name,
                  u.username AS invited_by_username,
                  u.display_name AS invited_by_display_name
           FROM household_members hm
           JOIN households h ON h.id = hm.household_id
           LEFT JOIN users u ON u.id = hm.invited_by_user_id
           WHERE hm.user_id = ? AND hm.status = 'pending'
           ORDER BY hm.created_at, hm.id""",
        (user_id,),
    ).fetchall()
    project_invite_rows = db.execute(
        """SELECT pm.*, p.name AS project_name, p.color AS project_color,
                  u.username AS invited_by_username, u.display_name AS invited_by_display_name
           FROM project_members pm
           JOIN projects p ON p.id = pm.project_id
           LEFT JOIN users u ON u.id = pm.invited_by
           WHERE pm.user_id = ? AND pm.status = 'pending'
           ORDER BY pm.created_at, pm.id""",
        (user_id,),
    ).fetchall()
    return {
        "type": "sync_response",
        "todos": get_sync_todo_payloads(db, user_id),
        "projects": projects,
        "sections": [dict(row) for row in sections_rows],
        "workspaces": [workspace_payload(r) for r in workspaces_rows],
        "household": household_payload,
        "household_invites": [dict(row) for row in household_invite_rows],
        "project_invites": [dict(row) for row in project_invite_rows],
    }


async def broadcast_sync_to_users(user_ids: set[int]):
    """Refresh connected users after an access-boundary transition."""
    with get_db() as db:
        messages = [(user_id, get_sync_payload(db, user_id)) for user_id in sorted(user_ids)]
    for user_id, message in messages:
        await manager.broadcast_to_user(user_id, message)


async def websocket_endpoint(websocket: WebSocket):
    ip = get_client_ip_ws(websocket)
    if not rate_limiter.check_ws(ip):
        await websocket.close(code=1008, reason="Too many connections")
        return
    rate_limiter.ws_connect(ip)
    try:
        await manager.connect(websocket)
        ws_user_id = None
        ws_token = None

        try:
            data = await asyncio.wait_for(websocket.receive_json(), timeout=5.0)
        except asyncio.TimeoutError:
            await websocket.close(code=1008)
            return

        msg_type = data.get("type", "")
        if msg_type == "auth":
            token = data.get("token")
            user_id = get_current_user(token, client_ip=ip)
            if user_id:
                ws_user_id = user_id
                ws_token = token
                manager.register_auth(websocket, user_id)
                await manager.send_personal_message({"type": "auth_ok", "user_id": user_id}, websocket)
                update_status = await asyncio.to_thread(get_public_update_status)
                await manager.send_personal_message(
                    {"type": "server_update_status", "payload": update_status},
                    websocket,
                )
            else:
                await websocket.close(code=1008)
                return
        else:
            await websocket.close(code=1008)
            return

        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type", "")

            if msg_type == "auth":
                # Authentication is immutable for the lifetime of a socket.
                # Reconnect to change accounts so in-flight broadcasts cannot
                # cross an identity boundary.
                await websocket.close(code=1008, reason="Already authenticated")
                return
            elif msg_type == "ping":
                await manager.send_personal_message({"type": "pong", "ts": now_iso()}, websocket)
            elif msg_type == "desktop_notify_ready":
                manager.register_desktop_notifications(websocket, bool(data.get("enabled")))
            elif msg_type == "sync_request":
                if not ws_user_id or not ws_token:
                    await manager.send_personal_message({"type": "error", "message": "Not authenticated"}, websocket)
                    continue
                current_user_id = get_current_user(ws_token, client_ip=ip)
                if current_user_id != ws_user_id:
                    await websocket.close(code=1008, reason="Session revoked")
                    return
                with get_db() as db:
                    sync_payload = get_sync_payload(db, ws_user_id)
                await manager.send_personal_message(sync_payload, websocket)
    except Exception:
        pass
    finally:
        manager.disconnect(websocket)
        rate_limiter.ws_disconnect(ip)
