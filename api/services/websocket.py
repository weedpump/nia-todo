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

    async def connect(self, websocket: WebSocket):
        await websocket.accept()

    def disconnect(self, websocket: WebSocket):
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

    async def broadcast_to_user(self, user_id: int, message: dict):
        if user_id not in self.connections:
            return
        for connection in self.connections[user_id][:]:
            try:
                await connection.send_json(message)
            except:
                pass

    async def broadcast(self, message: dict):
        for user_id, connections in list(self.connections.items()):
            for connection in connections[:]:
                try:
                    await connection.send_json(message)
                except:
                    pass


manager = ConnectionManager()


async def broadcast_change(event_type: str, payload: dict, user_id: int, project_id: int | None = None):
    """Broadcast change to the owning user and optional shared-project members."""
    recipients = {user_id}

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
