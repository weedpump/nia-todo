"""nia-todo: WebSocket connection manager and helpers"""

from fastapi import WebSocket, WebSocketDisconnect
from typing import Optional

from db import get_db, row_to_dict, now_iso
from services.auth import get_current_user
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
        if user_id and user_id in self.connections:
            if websocket in self.connections[user_id]:
                self.connections[user_id].remove(websocket)
            if not self.connections[user_id]:
                del self.connections[user_id]

    def register_auth(self, websocket: WebSocket, user_id: int):
        self.ws_users[websocket] = user_id
        if user_id not in self.connections:
            self.connections[user_id] = []
        self.connections[user_id].append(websocket)

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
    """Return the project row as the given viewer should see it.

    Owners see projects.workspace_id. Shared members see their own
    project_members.workspace_id as display workspace and the owner's real
    workspace as owner_workspace_id.
    """
    own = db.execute(
        "SELECT *, 0 as is_shared, 1 as is_owner FROM projects WHERE id = ? AND user_id = ?",
        (project_id, viewer_user_id),
    ).fetchone()
    if own:
        return dict(own)

    default_workspace = db.execute(
        "SELECT id FROM workspaces WHERE user_id = ? AND COALESCE(is_default, 0) = 1 ORDER BY id LIMIT 1",
        (viewer_user_id,),
    ).fetchone()
    default_workspace_id = default_workspace['id'] if default_workspace else None
    shared = db.execute(
        """
        SELECT p.id, p.name, p.color, p.sort_order, p.created_at,
               max(p.updated_at, COALESCE(pm.updated_at, p.updated_at)) as updated_at,
               p.parent_id, p.user_id, p.is_inbox, p.workspace_id as owner_workspace_id, p.icon,
               COALESCE(pm.workspace_id, ?) as workspace_id,
               1 as is_shared, 0 as is_owner, pm.id as member_id, pm.status as member_status,
               u.username as owner_username, u.display_name as owner_display_name
        FROM projects p
        JOIN project_members pm ON pm.project_id = p.id
        JOIN users u ON u.id = p.user_id
        WHERE p.id = ? AND pm.user_id = ? AND pm.status = 'accepted'
        """,
        (default_workspace_id, project_id, viewer_user_id),
    ).fetchone()
    return dict(shared) if shared else None


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
            placeholders = ','.join('?' for _ in unique_project_ids)
            owner_rows = db.execute(
                f"SELECT DISTINCT user_id FROM projects WHERE id IN ({placeholders}) AND user_id IS NOT NULL",
                tuple(unique_project_ids),
            ).fetchall()
            member_rows = db.execute(
                f"SELECT DISTINCT user_id FROM project_members WHERE project_id IN ({placeholders}) AND status = 'accepted'",
                tuple(unique_project_ids),
            ).fetchall()
            recipients = {actor_user_id}
            recipients.update(row['user_id'] for row in owner_rows)
            recipients.update(row['user_id'] for row in member_rows)

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
                project = db.execute("SELECT user_id FROM projects WHERE id = ?", (project_id,)).fetchone()
                if project and project[0] is not None:
                    recipients.add(project[0])
                rows = db.execute(
                    "SELECT user_id FROM project_members WHERE project_id = ? AND status = 'accepted'",
                    (project_id,),
                ).fetchall()
                recipients.update(r[0] for r in rows)
        except Exception:
            pass

    for uid in recipients:
        await manager.broadcast_to_user(uid, {"type": event_type, "payload": payload})
