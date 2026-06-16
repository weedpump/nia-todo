#!/usr/bin/env python3
"""Todo comments API regression tests."""

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
            display_name TEXT,
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
        CREATE TABLE todo_comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            todo_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            body TEXT NOT NULL,
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
    db.execute("INSERT INTO users (id, username, display_name, default_reminder_offset_minutes) VALUES (1, 'owner', 'Owner Display', NULL)")
    db.execute("INSERT INTO users (id, username, display_name, default_reminder_offset_minutes) VALUES (2, 'member', 'Member Display', NULL)")
    db.execute("INSERT INTO users (id, username, display_name, default_reminder_offset_minutes) VALUES (3, 'stranger', 'Stranger Display', NULL)")
    db.execute("INSERT INTO projects (id, name, user_id, is_inbox) VALUES (1, 'Inbox', 1, 1)")
    db.execute("INSERT INTO projects (id, name, user_id, is_inbox) VALUES (2, 'Shared', 1, 0)")
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
    owner = make_client(db, user_id=1)

    created = owner.post("/api/todos", json={"title": "Document rollout", "project_id": 2})
    assert_true(created.status_code == 200, created.text)
    todo_id = created.json()["id"]

    added = owner.post(f"/api/todos/{todo_id}/comments", json={"body": "First note"})
    assert_true(added.status_code == 200, added.text)
    body = added.json()
    comment_id = body["comment"]["id"]
    assert_true(body["todo"]["comments_count"] == 1, body)
    assert_true(body["todo"]["comments"][0]["body"] == "First note", body)
    assert_true(body["todo"]["comments"][0]["author_display_name"] == "Owner Display", body)
    assert_true(body["todo"]["comments"][0]["author_username"] == "owner", body)
    assert_true(body["todo"]["comments"][0]["created_at"].endswith("+00:00"), body)

    listed = owner.get("/api/todos")
    assert_true(listed.status_code == 200, listed.text)
    listed_todo = next(todo for todo in listed.json()["todos"] if todo["id"] == todo_id)
    assert_true(listed_todo["comments_count"] == 1, listed_todo)

    member = make_client(db, user_id=2)
    member_view = member.get(f"/api/todos/{todo_id}")
    assert_true(member_view.status_code == 200, member_view.text)
    assert_true(member_view.json()["comments"][0]["body"] == "First note", member_view.json())

    member_comment = member.post(f"/api/todos/{todo_id}/comments", json={"body": "Member note"})
    assert_true(member_comment.status_code == 200, member_comment.text)
    assert_true(member_comment.json()["todo"]["comments_count"] == 2, member_comment.text)
    assert_true(member_comment.json()["comment"]["author_display_name"] == "Member Display", member_comment.text)
    member_comment_id = member_comment.json()["comment"]["id"]

    member_cannot_edit_owner_comment = member.patch(
        f"/api/todos/{todo_id}/comments/{comment_id}",
        json={"body": "Member edit attempt"},
    )
    assert_true(member_cannot_edit_owner_comment.status_code == 403, member_cannot_edit_owner_comment.text)

    owner_cannot_edit_member_comment = owner.patch(
        f"/api/todos/{todo_id}/comments/{member_comment_id}",
        json={"body": "Owner edit attempt"},
    )
    assert_true(owner_cannot_edit_member_comment.status_code == 403, owner_cannot_edit_member_comment.text)

    member_can_edit_own_comment = member.patch(
        f"/api/todos/{todo_id}/comments/{member_comment_id}",
        json={"body": "Member note edited"},
    )
    assert_true(member_can_edit_own_comment.status_code == 200, member_can_edit_own_comment.text)
    assert_true(member_can_edit_own_comment.json()["comment"]["body"] == "Member note edited", member_can_edit_own_comment.text)

    stranger = make_client(db, user_id=3)
    forbidden = stranger.post(f"/api/todos/{todo_id}/comments", json={"body": "Nope"})
    assert_true(forbidden.status_code in (403, 404), forbidden.text)

    member_cannot_delete_owner_comment = member.delete(f"/api/todos/{todo_id}/comments/{comment_id}")
    assert_true(member_cannot_delete_owner_comment.status_code == 403, member_cannot_delete_owner_comment.text)

    owner_can_delete_member_comment = owner.delete(f"/api/todos/{todo_id}/comments/{member_comment_id}")
    assert_true(owner_can_delete_member_comment.status_code == 200, owner_can_delete_member_comment.text)
    assert_true(owner_can_delete_member_comment.json()["todo"]["comments_count"] == 1, owner_can_delete_member_comment.text)

    second_member_comment = member.post(f"/api/todos/{todo_id}/comments", json={"body": "Member disposable note"})
    assert_true(second_member_comment.status_code == 200, second_member_comment.text)
    second_member_comment_id = second_member_comment.json()["comment"]["id"]
    member_can_delete_own_comment = member.delete(f"/api/todos/{todo_id}/comments/{second_member_comment_id}")
    assert_true(member_can_delete_own_comment.status_code == 200, member_can_delete_own_comment.text)
    assert_true(member_can_delete_own_comment.json()["todo"]["comments_count"] == 1, member_can_delete_own_comment.text)

    deleted = owner.delete(f"/api/todos/{todo_id}/comments/{comment_id}")
    assert_true(deleted.status_code == 200, deleted.text)
    assert_true(deleted.json()["todo"]["comments_count"] == 0, deleted.text)

    empty = owner.post(f"/api/todos/{todo_id}/comments", json={"body": "   "})
    assert_true(empty.status_code == 422, empty.text)

    print("✅ Todo comments API tests passed")


if __name__ == "__main__":
    main()
