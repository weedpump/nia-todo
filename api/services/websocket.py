"""nia-todo: WebSocket connection manager and helpers"""

from fastapi import WebSocket, WebSocketDisconnect
from typing import Optional

from db import get_db, row_to_dict, now_iso
from services.auth import get_current_user
from services.sharing import get_project_access_flags, get_project_participant_user_ids
from rate_limit import rate_limiter, get_client_ip_ws


class ConnectionManager:
    def __init__(self):
        self.connections: dict[int, list[WebSocket]] = {}
        self.ws_users: dict[WebSocket, int] = {}
        self.desktop_notify_connections: set[WebSocket] = set()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()

    def disconnect(self, websocket: WebSocket):
        self.desktop_notify_connections.discard(websocket)
        user_id = self.ws_users.pop(websocket, None)
        if user_id is not None and user_id in self.connections:
            self.connections[user_id] = [connection for connection in self.connections[user_id] if connection is not websocket]
            if not self.connections[user_id]:
                del self.connections[user_id]

    def register_auth(self, websocket: WebSocket, user_id: int):
        previous_user_id = self.ws_users.get(websocket)
        if previous_user_id is not None and previous_user_id != user_id:
            previous_connections = self.connections.get(previous_user_id, [])
            self.connections[previous_user_id] = [connection for connection in previous_connections if connection is not websocket]
            if not self.connections[previous_user_id]:
                del self.connections[previous_user_id]

        self.ws_users[websocket] = user_id
        connections = self.connections.setdefault(user_id, [])
        if websocket not in connections:
            connections.append(websocket)

    async def send_personal_message(self, message: dict, websocket: WebSocket):
        await websocket.send_json(message)

    def register_desktop_notifications(self, websocket: WebSocket, enabled: bool):
        if enabled:
            self.desktop_notify_connections.add(websocket)
        else:
            self.desktop_notify_connections.discard(websocket)

    async def broadcast_to_user(self, user_id: int, message: dict):
        if user_id not in self.connections:
            return False
        sent = False
        for connection in self.connections[user_id][:]:
            try:
                await connection.send_json(message)
                sent = True
            except:
                self.disconnect(connection)
        return sent

    async def disconnect_user(self, user_id: int, code: int = 4001, reason: str = "Session invalidated"):
        connections = list(self.connections.get(user_id, []))
        closed = False
        for connection in connections:
            try:
                await connection.close(code=code, reason=reason)
                closed = True
            except Exception:
                pass
            finally:
                self.disconnect(connection)
        return closed

    async def broadcast_desktop_notification(self, user_id: int, message: dict):
        if user_id not in self.connections:
            return False
        sent = False
        for connection in self.connections[user_id][:]:
            if connection not in self.desktop_notify_connections:
                continue
            try:
                await connection.send_json(message)
                sent = True
            except:
                pass
        return sent

    async def broadcast(self, message: dict):
        for user_id, connections in list(self.connections.items()):
            for connection in connections[:]:
                try:
                    await connection.send_json(message)
                except:
                    pass


manager = ConnectionManager()


def get_project_view_for_user(db, project_id: int, viewer_user_id: int) -> dict | None:
    row = db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    if not row:
        return None
    flags = get_project_access_flags(db, project_id, viewer_user_id)
    if not flags["can_view"]:
        return None
    ownership = flags["ownership"] or {}
    member = flags["direct_member"]
    project = dict(row)
    default_workspace = db.execute(
        "SELECT id FROM workspaces WHERE user_id = ? AND COALESCE(is_default, 0) = 1 ORDER BY id LIMIT 1",
        (viewer_user_id,),
    ).fetchone()
    default_workspace_id = default_workspace["id"] if default_workspace else None
    if flags["can_manage"] and ownership.get("owner_user_id") == viewer_user_id:
        workspace_id = row["workspace_id"]
    elif member and member["workspace_id"] is not None:
        workspace_id = member["workspace_id"]
    else:
        workspace_id = default_workspace_id
    project["workspace_id"] = workspace_id
    project["owner_workspace_id"] = row["workspace_id"]
    project["owner_user_id"] = ownership.get("owner_user_id")
    project["owner_household_id"] = ownership.get("owner_household_id")
    project["ownership_type"] = "household" if ownership.get("owner_household_id") is not None else "user"
    project["is_shared"] = 0 if flags["can_manage"] else 1
    project["is_owner"] = 1 if flags["can_manage"] else 0
    if flags["can_manage"]:
        member_rows = db.execute(
            """SELECT pm.*, u.username, u.display_name
               FROM project_members pm
               JOIN users u ON u.id = pm.user_id
               WHERE pm.project_id = ? AND pm.status IN ('pending', 'accepted')
               ORDER BY CASE pm.status WHEN 'accepted' THEN 0 ELSE 1 END, u.username""",
            (project_id,),
        ).fetchall()
        project["members"] = [dict(member_row) for member_row in member_rows]
    if member:
        project["member_id"] = member["id"]
        project["member_status"] = member["status"]
    if ownership.get("owner_user_id") is not None:
        owner = db.execute(
            "SELECT username, display_name FROM users WHERE id = ?",
            (ownership["owner_user_id"],),
        ).fetchone()
        project["owner_username"] = owner["username"] if owner else None
        project["owner_display_name"] = owner["display_name"] if owner else None
        project["household_name"] = None
    else:
        household = db.execute(
            "SELECT name FROM households WHERE id = ?",
            (ownership.get("owner_household_id"),),
        ).fetchone()
        project["owner_username"] = None
        project["owner_display_name"] = None
        project["household_name"] = household["name"] if household else None
    return project


async def broadcast_project_updates(project_ids: list[int], actor_user_id: int):
    """Broadcast recipient-specific project views for one or more changed projects."""
    unique_project_ids = []
    seen = set()
    for project_id in project_ids:
        if project_id not in seen:
            unique_project_ids.append(project_id)
            seen.add(project_id)
    if not unique_project_ids:
        return

    try:
        with get_db() as db:
            recipients = {actor_user_id}
            for project_id in unique_project_ids:
                recipients.update(get_project_participant_user_ids(db, project_id))

            messages = []
            for uid in recipients:
                views = [get_project_view_for_user(db, project_id, uid) for project_id in unique_project_ids]
                views = [view for view in views if view is not None]
                if not views:
                    continue
                messages.append((uid, views))
    except Exception:
        return

    for uid, views in messages:
        if len(views) == 1:
            await manager.broadcast_to_user(uid, {"type": "project_update", "payload": views[0]})
        else:
            await manager.broadcast_to_user(uid, {"type": "project_update_many", "payload": {"projects": views}})


async def broadcast_change(event_type: str, payload: dict, user_id: int, project_id: int | None = None, recipient_ids: set[int] | None = None):
    """Broadcast change to the owning user and optional shared-project members."""
    recipients = {user_id}
    if recipient_ids:
        recipients.update(recipient_ids)

    if project_id is not None:
        try:
            with get_db() as db:
                recipients.update(get_project_participant_user_ids(db, project_id))
        except Exception:
            pass

    for uid in recipients:
        await manager.broadcast_to_user(uid, {"type": event_type, "payload": payload})
