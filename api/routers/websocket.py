"""nia-todo: WebSocket endpoint handler"""

import asyncio
from fastapi import WebSocket

from db import get_db, row_to_dict, now_iso
from services.auth import get_current_user
from services.sharing import get_project_ids_for_user
from services.websocket import manager
from rate_limit import rate_limiter, get_client_ip_ws


async def websocket_endpoint(websocket: WebSocket):
    ip = get_client_ip_ws(websocket)
    if not rate_limiter.check_ws(ip):
        await websocket.close(code=1008, reason="Too many connections")
        return
    rate_limiter.ws_connect(ip)
    try:
        await manager.connect(websocket)
        ws_user_id = None

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
                manager.register_auth(websocket, user_id)
                await manager.send_personal_message({"type": "auth_ok", "user_id": user_id}, websocket)
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
                token = data.get("token")
                user_id = get_current_user(token, client_ip=ip)
                if user_id:
                    ws_user_id = user_id
                    manager.register_auth(websocket, user_id)
                    await manager.send_personal_message({"type": "auth_ok", "user_id": user_id}, websocket)
                else:
                    await manager.send_personal_message({"type": "auth_fail"}, websocket)
            elif msg_type == "ping":
                await manager.send_personal_message({"type": "pong", "ts": now_iso()}, websocket)
            elif msg_type == "desktop_notify_ready":
                manager.register_desktop_notifications(websocket, bool(data.get("enabled")))
            elif msg_type == "sync_request":
                if not ws_user_id:
                    await manager.send_personal_message({"type": "error", "message": "Not authenticated"}, websocket)
                    continue
                with get_db() as db:
                    project_ids = get_project_ids_for_user(db, ws_user_id)
                    params = []
                    todos_sql = """
                        SELECT t.*, p.name as project_name, s.name as section_name FROM todos t
                        LEFT JOIN projects p ON t.project_id = p.id
                        LEFT JOIN sections s ON t.section_id = s.id
                        WHERE t.status != 'archived'
                    """
                    if project_ids:
                        placeholders = ','.join('?' for _ in project_ids)
                        todos_sql += f" AND (t.user_id = ? OR t.project_id IN ({placeholders}))"
                        params.extend([ws_user_id, *project_ids])
                    else:
                        todos_sql += " AND t.user_id = ?"
                        params.append(ws_user_id)
                    todos_sql += " ORDER BY CASE t.status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, t.priority, t.due_date IS NULL, t.due_date"
                    todos_rows = db.execute(todos_sql, params).fetchall()

                    todos_out = []
                    for r in todos_rows:
                        d = row_to_dict(r)
                        rem_rows = db.execute(
                            """SELECT id, remind_at, sent_at FROM reminders
                               WHERE todo_id = ? AND (user_id = ? OR user_id IS NULL)
                               ORDER BY remind_at""",
                            (d['id'], ws_user_id)
                        ).fetchall()
                        d['reminders'] = [dict(r) for r in rem_rows]
                        todos_out.append(d)

                    own_projects = db.execute(
                        "SELECT *, 0 as is_shared, 1 as is_owner FROM projects WHERE user_id = ? ORDER BY COALESCE(is_inbox, 0) DESC, parent_id, sort_order, id",
                        (ws_user_id,)
                    ).fetchall()
                    default_workspace = db.execute(
                        "SELECT id FROM workspaces WHERE user_id = ? AND COALESCE(is_default, 0) = 1 ORDER BY id LIMIT 1",
                        (ws_user_id,),
                    ).fetchone()
                    default_workspace_id = default_workspace['id'] if default_workspace else None
                    shared_projects = db.execute(
                        """SELECT p.id, p.name, p.color, p.sort_order, p.created_at, max(p.updated_at, COALESCE(pm.updated_at, p.updated_at)) as updated_at, p.parent_id,
                   p.user_id, p.is_inbox, p.workspace_id as owner_workspace_id, p.icon,
                   COALESCE(pm.workspace_id, ?) as workspace_id,
                                  1 as is_shared, 0 as is_owner, pm.id as member_id, pm.status as member_status,
                                  u.username as owner_username, u.display_name as owner_display_name
                           FROM projects p
                           JOIN project_members pm ON pm.project_id = p.id
                           JOIN users u ON u.id = p.user_id
                           WHERE pm.user_id = ? AND pm.status = 'accepted'
                           ORDER BY p.name""",
                        (default_workspace_id, ws_user_id)
                    ).fetchall()
                    sections_rows = db.execute(
                        """SELECT s.* FROM sections s
                           JOIN projects p ON s.project_id = p.id
                           LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ? AND pm.status = 'accepted'
                           WHERE p.user_id = ? OR pm.user_id IS NOT NULL
                           ORDER BY s.sort_order, s.id""",
                        (ws_user_id, ws_user_id)
                    ).fetchall()
                    workspaces_rows = db.execute(
                        "SELECT * FROM workspaces WHERE user_id = ? ORDER BY COALESCE(is_default, 0) DESC, sort_order, name, id",
                        (ws_user_id,)
                    ).fetchall()
                    await manager.send_personal_message({
                        "type": "sync_response",
                        "todos": todos_out,
                        "projects": [dict(r) for r in own_projects] + [dict(r) for r in shared_projects],
                        "sections": [dict(r) for r in sections_rows],
                        "workspaces": [dict(r) for r in workspaces_rows]
                    }, websocket)
    except Exception:
        pass
    finally:
        manager.disconnect(websocket)
        rate_limiter.ws_disconnect(ip)
