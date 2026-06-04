#!/usr/bin/env python3
"""Default due-date reminder API regression tests."""

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


def make_db(default_offset=60):
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
    db.execute("INSERT INTO users (id, username, default_reminder_offset_minutes) VALUES (1, 'tobi', ?)", (default_offset,))
    db.execute("INSERT INTO projects (id, name, user_id, is_inbox) VALUES (1, 'Inbox', 1, 1)")
    db.commit()
    return db


async def noop_broadcast(*_args, **_kwargs):
    return None


def make_client(db):
    app = FastAPI()
    app.include_router(todos_router.router)
    app.dependency_overrides[require_auth] = lambda: 1

    @contextlib.contextmanager
    def fake_get_db():
        yield db

    todos_router.get_db = fake_get_db
    todos_router.broadcast_change = noop_broadcast
    return TestClient(app)


def main():
    db = make_db(default_offset=60)
    client = make_client(db)

    created = client.post("/api/todos", json={
        "title": "Heizung prüfen",
        "project_id": 1,
        "due_date": "2026-06-04T18:00:00+02:00",
    })
    assert_true(created.status_code == 200, created.text)
    todo = created.json()
    assert_true(todo["reminders"][0]["remind_at"] == "2026-06-04T17:00:00+02:00", todo)
    assert_true(todo["reminders"][0]["source"] == "default_due", todo)

    explicit = client.post("/api/todos", json={
        "title": "Explizit",
        "project_id": 1,
        "due_date": "2026-06-04T18:00:00+02:00",
        "remind_at": "2026-06-04T12:00:00+02:00",
    })
    assert_true(explicit.status_code == 200, explicit.text)
    explicit_todo = explicit.json()
    assert_true(explicit_todo["reminders"][0]["remind_at"] == "2026-06-04T12:00:00+02:00", explicit_todo)
    assert_true(explicit_todo["reminders"][0]["source"] == "explicit", explicit_todo)

    moved = client.patch(f"/api/todos/{todo['id']}", json={"due_date": "2026-06-04T20:00:00+02:00"})
    assert_true(moved.status_code == 200, moved.text)
    moved_todo = moved.json()
    assert_true(moved_todo["reminders"][0]["remind_at"] == "2026-06-04T19:00:00+02:00", moved_todo)

    explicit_moved = client.patch(f"/api/todos/{explicit_todo['id']}", json={"due_date": "2026-06-04T20:00:00+02:00"})
    assert_true(explicit_moved.status_code == 200, explicit_moved.text)
    explicit_after = explicit_moved.json()
    assert_true(explicit_after["reminders"][0]["remind_at"] == "2026-06-04T12:00:00+02:00", explicit_after)

    recurring = client.post("/api/todos", json={
        "title": "Täglich",
        "project_id": 1,
        "due_date": "2026-06-04T18:00:00+02:00",
        "recurring_rule": {"frequency": "daily", "interval": 1},
    })
    assert_true(recurring.status_code == 200, recurring.text)
    done = client.patch(f"/api/todos/{recurring.json()['id']}", json={"status": "done"})
    assert_true(done.status_code == 200, done.text)
    next_todo = done.json()["recurrence_created_todo"]
    assert_true(next_todo["due_date"] == "2026-06-05T18:00:00+02:00", next_todo)
    assert_true(next_todo["reminders"][0]["remind_at"] == "2026-06-05T17:00:00+02:00", next_todo)
    assert_true(next_todo["reminders"][0]["source"] == "default_due", next_todo)

    off_db = make_db(default_offset=None)
    off_client = make_client(off_db)
    off_created = off_client.post("/api/todos", json={
        "title": "Ohne Default",
        "project_id": 1,
        "due_date": "2026-06-04T18:00:00+02:00",
    })
    assert_true(off_created.status_code == 200, off_created.text)
    assert_true(off_created.json()["reminders"] == [], off_created.json())

    print("✅ default reminder offset API tests passed")


if __name__ == "__main__":
    main()
