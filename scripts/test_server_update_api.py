#!/usr/bin/env python3
"""Authenticated server-update endpoint contracts."""
import asyncio
import sys
import threading
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from routers import admin as admin_router
from routers import server_updates as server_updates_router

paths = {route.path: route for route in server_updates_router.router.routes}
assert "/api/server-update" in paths
route = paths["/api/server-update"]
assert "GET" in route.methods
assert route.dependant.dependencies, "server update endpoint must require authentication"

with patch.object(server_updates_router, "get_public_update_status", return_value={"update_available": True, "stale": False}):
    result = server_updates_router.get_server_update_status(user_id=123)
assert result == {"update_available": True, "stale": False}
assert set(result) == {"update_available", "stale"}


async def test_admin_status_offloads_blocking_status_work():
    event_loop_thread = threading.get_ident()
    worker_threads = []

    def blocking_status():
        worker_threads.append(threading.get_ident())
        return {"update_available": False}

    with patch.object(admin_router, "perform_update_check", new=AsyncMock()), \
         patch.object(admin_router, "get_update_status", side_effect=blocking_status):
        result = await admin_router.admin_get_server_update_status()

    assert result == {"update_available": False}
    assert worker_threads and worker_threads[0] != event_loop_thread, "blocking admin status work must run outside the event loop"


asyncio.run(test_admin_status_offloads_blocking_status_work())

print("✅ Server update API tests passed")
