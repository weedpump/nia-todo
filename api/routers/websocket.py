"""nia-todo: WebSocket endpoint handler"""

import asyncio
from fastapi import WebSocket

from db import get_db, row_to_dict, now_iso
from services.auth import get_current_user
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
            user_id = get_current_user(token)
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
                user_id = get_current_user(token)
                if user_id:
                    ws_user_id = user_id
                    manager.register_auth(websocket, user_id)
                    await manager.send_personal_message({"type": "auth_ok", "user_id": user_id}, websocket)
                else:
                    await manager.send_personal_message({"type": "auth_fail"}, websocket)
            elif msg_type == "ping":
                await manager.send_personal_message({"type": "pong", "ts": now_iso()}, websocket)
            elif msg_type == "sync_request":
                if not ws_user_id:
                    await manager.send_personal_message({"type": "error", "message": "Not authenticated"}, websocket)
                    continue
                with get_db() as db:
                    todos_rows = db.execute("""
                        SELECT t.*, p.name as project_name, s.name as section_name FROM todos t
                        LEFT JOIN projects p ON t.project_id = p.id
                        LEFT JOIN sections s ON t.section_id = s.id
                        WHERE t.user_id = ? AND t.status != 'archived'
                        ORDER BY CASE t.status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, t.priority, t.due_date IS NULL, t.due_date
                    """, (ws_user_id,)).fetchall()
                    todos_out = []
                    for r in todos_rows:
                        d = row_to_dict(r)
                        rem_rows = db.execute(
                            "SELECT id, remind_at, sent_at FROM reminders WHERE todo_id = ? ORDER BY remind_at",
                            (d['id'],)
                        ).fetchall()
                        d['reminders'] = [dict(r) for r in rem_rows]
                        todos_out.append(d)
                    projects_rows = db.execute("SELECT * FROM projects WHERE user_id = ? ORDER BY sort_order, id", (ws_user_id,)).fetchall()
                    sections_rows = db.execute("SELECT * FROM sections WHERE user_id = ?", (ws_user_id,)).fetchall()
                    await manager.send_personal_message({
                        "type": "sync_response",
                        "todos": todos_out,
                        "projects": [dict(r) for r in projects_rows],
                        "sections": [dict(r) for r in sections_rows]
                    }, websocket)
    except Exception:
        pass
    finally:
        manager.disconnect(websocket)
        rate_limiter.ws_disconnect(ip)
