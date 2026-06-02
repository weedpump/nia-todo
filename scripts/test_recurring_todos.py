#!/usr/bin/env python3
"""Recurring todo API regression tests."""

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
            created_at TEXT DEFAULT (datetime('now')),
            user_id INTEGER
        );
        """
    )
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
    db = make_db()
    client = make_client(db)

    create_payload = {
        "title": "Medikamente nehmen",
        "description": "Nach dem Frühstück",
        "priority": 2,
        "project_id": 1,
        "due_date": "2026-06-02T08:00:00+02:00",
        "remind_at": "2026-06-02T07:30:00+02:00",
        "recurring_rule": {"frequency": "daily", "interval": 1},
    }
    res = client.post("/api/todos", json=create_payload)
    assert_true(res.status_code == 200, res.text)
    todo = res.json()
    assert_true(todo["recurring_rule"] == {"frequency": "daily", "interval": 1, "preserve_time": True}, todo)

    done_res = client.patch(f"/api/todos/{todo['id']}", json={"status": "done"})
    assert_true(done_res.status_code == 200, done_res.text)
    done = done_res.json()
    next_todo = done.get("recurrence_created_todo")
    assert_true(done["status"] == "done", done)
    assert_true(next_todo and next_todo["status"] == "pending", done)
    assert_true(next_todo["due_date"] == "2026-06-03T08:00:00+02:00", next_todo)
    assert_true(next_todo["reminders"][0]["remind_at"] == "2026-06-03T07:30:00+02:00", next_todo)
    assert_true(next_todo["recurring_rule"]["frequency"] == "daily", next_todo)

    reopen_res = client.patch(f"/api/todos/{todo['id']}", json={"status": "pending"})
    assert_true(reopen_res.status_code == 200, reopen_res.text)
    done_again_res = client.patch(f"/api/todos/{todo['id']}", json={"status": "done"})
    assert_true(done_again_res.status_code == 200, done_again_res.text)
    done_again = done_again_res.json()
    assert_true(done_again.get("recurrence_created_todo", {}).get("id") == next_todo["id"], done_again)
    all_todos = client.get("/api/todos").json()["todos"]
    tomorrow_occurrences = [item for item in all_todos if item.get("parent_id") == todo["id"] and item.get("due_date") == "2026-06-03T08:00:00+02:00"]
    assert_true(len(tomorrow_occurrences) == 1, tomorrow_occurrences)

    invalid = client.post("/api/todos", json={"title": "No deadline", "recurring_rule": {"frequency": "weekly"}})
    assert_true(invalid.status_code == 422, invalid.text)

    print("✅ recurring todo API tests passed")


if __name__ == "__main__":
    main()
