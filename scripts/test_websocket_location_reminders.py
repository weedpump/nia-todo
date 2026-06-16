#!/usr/bin/env python3
"""WebSocket sync regression coverage for location reminders."""

from __future__ import annotations

import contextlib
import sqlite3
import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

import routers.websocket as websocket_router  # noqa: E402


def assert_true(condition, message):
    if not condition:
        raise AssertionError(message)


def make_db():
    db = sqlite3.connect(":memory:", check_same_thread=False)
    db.row_factory = sqlite3.Row
    db.executescript(
        """
        CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, display_name TEXT);
        CREATE TABLE projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            color TEXT,
            sort_order REAL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            parent_id INTEGER,
            user_id INTEGER,
            is_inbox INTEGER DEFAULT 0,
            workspace_id INTEGER,
            icon TEXT
        );
        CREATE TABLE project_members (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, user_id INTEGER NOT NULL, status TEXT DEFAULT 'accepted', workspace_id INTEGER, updated_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE sections (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, name TEXT NOT NULL, sort_order REAL DEFAULT 0);
        CREATE TABLE workspaces (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, is_default INTEGER DEFAULT 0, sort_order REAL DEFAULT 0);
        CREATE TABLE todos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            priority INTEGER DEFAULT 3,
            is_pinned INTEGER DEFAULT 0,
            status TEXT DEFAULT 'pending',
            due_date TEXT,
            completed_at TEXT,
            project_id INTEGER,
            section_id INTEGER,
            sort_order REAL DEFAULT 0,
            recurring_rule TEXT,
            parent_id INTEGER,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            user_id INTEGER
        );

        CREATE TABLE todo_subtasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            todo_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            is_done INTEGER NOT NULL DEFAULT 0,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, todo_id INTEGER NOT NULL, remind_at TEXT NOT NULL, sent_at TEXT, user_id INTEGER);
        CREATE TABLE saved_places (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, address TEXT NOT NULL, icon TEXT DEFAULT 'pin');
        CREATE TABLE location_reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            todo_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            trigger_type TEXT NOT NULL,
            place_id INTEGER,
            address TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            triggered_at TEXT,
            source TEXT NOT NULL DEFAULT 'explicit',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        """
    )
    db.execute("INSERT INTO users (id, username) VALUES (1, 'tobi')")
    db.execute("INSERT INTO projects (id, name, user_id, is_inbox) VALUES (1, 'Inbox', 1, 1)")
    db.execute("INSERT INTO todos (id, title, project_id, user_id, updated_at) VALUES (2, 'Hhhh', 1, 1, '2026-06-04T12:33:27.461673+00:00')")
    db.execute("""INSERT INTO location_reminders (id, todo_id, user_id, trigger_type, address, enabled, created_at, updated_at)
                  VALUES (6, 2, 1, 'arrival', 'Johanneck 24 85307 paunzhausen', 1, '2026-06-04T12:33:27.461619+00:00', '2026-06-04T12:33:27.461619+00:00')""")
    db.commit()
    return db


def main():
    db = make_db()

    @contextlib.contextmanager
    def fake_get_db():
        yield db

    websocket_router.get_db = fake_get_db
    valid_tokens = {"ok", "revokable"}
    websocket_router.get_current_user = lambda token, client_ip=None: 1 if token in valid_tokens else None
    websocket_router.get_project_ids_for_user = lambda _db, user_id: [1]

    app = FastAPI()
    app.add_api_websocket_route("/ws", websocket_router.websocket_endpoint)
    client = TestClient(app)

    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "auth", "token": "ok"})
        auth = ws.receive_json()
        assert_true(auth.get("type") == "auth_ok", auth)
        ws.send_json({"type": "sync_request"})
        sync = ws.receive_json()

    assert_true(sync.get("type") == "sync_response", sync)
    todo = next(item for item in sync["todos"] if item["id"] == 2)
    assert_true(todo["location_reminder"]["address"] == "Johanneck 24 85307 paunzhausen", todo)
    assert_true(todo["location_reminders"][0]["trigger_type"] == "arrival", todo)

    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "auth", "token": "revokable"})
        auth = ws.receive_json()
        assert_true(auth.get("type") == "auth_ok", auth)
        valid_tokens.remove("revokable")
        ws.send_json({"type": "sync_request"})
        try:
            ws.receive_json()
            raise AssertionError("revoked websocket token must close before sync_response")
        except WebSocketDisconnect as exc:
            assert_true(exc.code == 1008, f"expected policy close 1008, got {exc.code}")

    print("✅ WebSocket location reminder sync test passed")


if __name__ == "__main__":
    main()
