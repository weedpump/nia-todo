#!/usr/bin/env python3
"""WebSocket authentication registration is unique and reversible."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from services.websocket import ConnectionManager

manager = ConnectionManager()
socket = object()
for _ in range(1000):
    manager.register_auth(socket, 1)
assert manager.connections[1] == [socket]
assert manager.ws_users[socket] == 1

manager.register_auth(socket, 2)
assert 1 not in manager.connections
assert manager.connections[2] == [socket]
assert manager.ws_users[socket] == 2

manager.disconnect(socket)
assert manager.connections == {}
assert manager.ws_users == {}



import asyncio
from types import SimpleNamespace
import routers.websocket as websocket_router

class FakeWebSocket:
    def __init__(self):
        self.client = SimpleNamespace(host='127.0.0.1')
        self.headers = {}
        self.messages = [
            {'type': 'auth', 'token': 'one'},
            {'type': 'auth', 'token': 'two'},
        ]
        self.sent = []
        self.closed = None

    async def accept(self):
        pass

    async def receive_json(self):
        if self.messages:
            return self.messages.pop(0)
        raise RuntimeError('test complete')

    async def send_json(self, message):
        self.sent.append(message)

    async def close(self, code=1000, reason=''):
        self.closed = (code, reason)

fake = FakeWebSocket()
auth_calls = []
original_manager = websocket_router.manager
original_get_current_user = websocket_router.get_current_user
original_check_ws = websocket_router.rate_limiter.check_ws
original_ws_connect = websocket_router.rate_limiter.ws_connect
original_ws_disconnect = websocket_router.rate_limiter.ws_disconnect
try:
    websocket_router.manager = ConnectionManager()
    websocket_router.get_current_user = lambda token, client_ip=None: auth_calls.append(token) or {'one': 1, 'two': 2}.get(token)
    websocket_router.rate_limiter.check_ws = lambda _ip: True
    websocket_router.rate_limiter.ws_connect = lambda _ip: None
    websocket_router.rate_limiter.ws_disconnect = lambda _ip: None
    asyncio.run(websocket_router.websocket_endpoint(fake))
finally:
    websocket_router.manager = original_manager
    websocket_router.get_current_user = original_get_current_user
    websocket_router.rate_limiter.check_ws = original_check_ws
    websocket_router.rate_limiter.ws_connect = original_ws_connect
    websocket_router.rate_limiter.ws_disconnect = original_ws_disconnect

assert auth_calls == ['one']
assert fake.closed and fake.closed[0] == 1008

print("✅ WebSocket auth registration is unique and re-auth is rejected")
