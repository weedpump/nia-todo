#!/usr/bin/env python3
"""Checklist subtask API regression tests."""

from __future__ import annotations

import contextlib
import sqlite3
import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

import routers.todos as todos_router  # noqa: E402
from routers.auth import require_auth  # noqa: E402


def assert_true(condition, message):
    if not condition:
        raise AssertionError(message)


def make_db():
    db = sqlite3.connect(":memory:", check_same_thread=False)
    db.row_factory = sqlite3.Row
    db.executescript(
        """
        CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            default_reminder_offset_minutes INTEGER
        );
        CREATE TABLE projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            user_id INTEGER,
            is_inbox INTEGER DEFAULT 0
        );
        CREATE TABLE project_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            status TEXT DEFAULT 'accepted'
        );
        CREATE TABLE sections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            name TEXT NOT NULL
        );
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
        CREATE TABLE reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            todo_id INTEGER NOT NULL,
            remind_at TEXT NOT NULL,
            sent_at TEXT,
            source TEXT NOT NULL DEFAULT 'explicit',
            created_at TEXT DEFAULT (datetime('now')),
            user_id INTEGER
        );
        """
    )
    db.execute("INSERT INTO users (id, username, default_reminder_offset_minutes) VALUES (1, 'tobi', NULL)")
    db.execute("INSERT INTO users (id, username, default_reminder_offset_minutes) VALUES (2, 'shared', NULL)")
    db.execute("INSERT INTO projects (id, name, user_id, is_inbox) VALUES (1, 'Inbox', 1, 1)")
    db.execute("INSERT INTO projects (id, name, user_id, is_inbox) VALUES (2, 'Shared Project', 1, 0)")
    db.execute("INSERT INTO project_members (project_id, user_id, status) VALUES (2, 2, 'accepted')")
    db.commit()
    return db


async def noop_broadcast(*_args, **_kwargs):
    return None


def make_client(db, user_id=1):
    app = FastAPI()
    app.include_router(todos_router.router)
    app.dependency_overrides[require_auth] = lambda: user_id

    @contextlib.contextmanager
    def fake_get_db():
        yield db

    todos_router.get_db = fake_get_db
    todos_router.broadcast_change = noop_broadcast
    return TestClient(app)


def main():
    db = make_db()
    client = make_client(db)

    created = client.post("/api/todos", json={
        "title": "Server Migration",
        "project_id": 1,
        "subtasks": [
            {"title": "Backup prüfen"},
            {"title": "DNS umstellen", "is_done": True},
        ],
    })
    assert_true(created.status_code == 200, created.text)
    todo = created.json()
    assert_true(len(todo["subtasks"]) == 2, todo)
    assert_true(todo["subtasks"][0]["title"] == "Backup prüfen", todo)
    assert_true(todo["subtasks"][1]["is_done"] is True, todo)

    blocked = client.patch(f"/api/todos/{todo['id']}", json={"status": "done"})
    assert_true(blocked.status_code == 409, blocked.text)

    confirmed = client.patch(f"/api/todos/{todo['id']}", json={
        "status": "done",
        "confirm_incomplete_subtasks_completion": True,
    })
    assert_true(confirmed.status_code == 200, confirmed.text)
    assert_true(confirmed.json()["status"] == "done", confirmed.json())

    updated = client.patch(f"/api/todos/{todo['id']}", json={
        "status": "pending",
        "subtasks": [
            {"title": "Backup prüfen", "is_done": True},
            {"title": "DNS umstellen", "is_done": True},
            {"title": "Monitoring checken", "is_done": False},
        ],
    })
    assert_true(updated.status_code == 200, updated.text)
    body = updated.json()
    assert_true(len(body["subtasks"]) == 3, body)
    assert_true(body["subtasks"][2]["title"] == "Monitoring checken", body)

    recurring = client.post("/api/todos", json={
        "title": "Wöchentlicher Check",
        "project_id": 1,
        "due_date": "2026-06-16T09:00:00+02:00",
        "recurring_rule": {"frequency": "weekly", "interval": 1},
        "subtasks": [{"title": "Logs ansehen", "is_done": True}],
    })
    assert_true(recurring.status_code == 200, recurring.text)
    recurring_done = client.patch(f"/api/todos/{recurring.json()['id']}", json={"status": "done"})
    assert_true(recurring_done.status_code == 200, recurring_done.text)
    next_todo = recurring_done.json()["recurrence_created_todo"]
    assert_true(next_todo["subtasks"][0]["title"] == "Logs ansehen", next_todo)
    assert_true(next_todo["subtasks"][0]["is_done"] is False, next_todo)

    shared_created = client.post("/api/todos", json={
        "title": "Shared checklist",
        "project_id": 2,
        "subtasks": [{"title": "Owner item", "is_done": False}],
    })
    assert_true(shared_created.status_code == 200, shared_created.text)
    shared_todo_id = shared_created.json()["id"]
    shared_client = make_client(db, user_id=2)
    shared_list = shared_client.get("/api/todos?project_id=2")
    assert_true(shared_list.status_code == 200, shared_list.text)
    shared_view = next(todo for todo in shared_list.json()["todos"] if todo["id"] == shared_todo_id)
    assert_true(shared_view["subtasks"][0]["title"] == "Owner item", shared_view)
    shared_update = shared_client.patch(f"/api/todos/{shared_todo_id}", json={
        "subtasks": [
            {"title": "Owner item", "is_done": True},
            {"title": "Shared user item", "is_done": False},
        ]
    })
    assert_true(shared_update.status_code == 200, shared_update.text)
    assert_true(len(shared_update.json()["subtasks"]) == 2, shared_update.json())
    owner_view = client.get(f"/api/todos/{shared_todo_id}")
    assert_true(owner_view.json()["subtasks"][1]["title"] == "Shared user item", owner_view.json())

    print("✅ Subtask API tests passed")


if __name__ == "__main__":
    main()
