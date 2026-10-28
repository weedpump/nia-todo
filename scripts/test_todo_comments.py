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
            parent_id INTEGER,
            is_inbox INTEGER DEFAULT 0
        );
        CREATE TABLE project_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            status TEXT DEFAULT 'accepted'
        );
        CREATE TABLE entity_access (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_type TEXT NOT NULL,
            entity_id INTEGER NOT NULL,
            owner_user_id INTEGER,
            owner_household_id INTEGER
        );
        CREATE TABLE entity_access_grants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_access_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL
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
            client_mutation_id TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE todo_comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            todo_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            body TEXT NOT NULL,
            client_mutation_id TEXT,
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
        CREATE UNIQUE INDEX idx_todo_subtasks_client_mutation
            ON todo_subtasks(todo_id, client_mutation_id) WHERE client_mutation_id IS NOT NULL;
        CREATE UNIQUE INDEX idx_todo_comments_client_mutation
            ON todo_comments(todo_id, user_id, client_mutation_id) WHERE client_mutation_id IS NOT NULL;
        """
    )
    db.execute("INSERT INTO users (id, username, display_name, default_reminder_offset_minutes) VALUES (1, 'owner', 'Owner Display', NULL)")
    db.execute("INSERT INTO users (id, username, display_name, default_reminder_offset_minutes) VALUES (2, 'member', 'Member Display', NULL)")
    db.execute("INSERT INTO users (id, username, display_name, default_reminder_offset_minutes) VALUES (3, 'stranger', 'Stranger Display', NULL)")
    db.execute("INSERT INTO projects (id, name, user_id, is_inbox) VALUES (1, 'Inbox', 1, 1)")
    db.execute("INSERT INTO projects (id, name, user_id, is_inbox) VALUES (2, 'Shared', 1, 0)")
    db.execute("INSERT INTO entity_access (entity_type, entity_id, owner_user_id) VALUES ('project', 1, 1)")
    db.execute("INSERT INTO entity_access (entity_type, entity_id, owner_user_id) VALUES ('project', 2, 1)")
    db.execute("INSERT INTO project_members (project_id, user_id, status) VALUES (2, 2, 'accepted')")
    db.commit()
    return db


async def noop_broadcast(*_args, **_kwargs):
    return None


def make_broadcast_collector(events):
    async def collect(event_type, payload, user_id, project_id=None, recipient_ids=None):
        events.append({
            "event_type": event_type,
            "payload": payload,
            "user_id": user_id,
            "project_id": project_id,
            "recipient_ids": recipient_ids,
        })
    return collect


def make_client(db, user_id=1, broadcast_events=None):
    app = FastAPI()
    app.include_router(todos_router.router)
    app.dependency_overrides[require_auth] = lambda: user_id

    @contextlib.contextmanager
    def fake_get_db():
        yield db

    todos_router.get_db = fake_get_db
    todos_router.broadcast_change = make_broadcast_collector(broadcast_events) if broadcast_events is not None else noop_broadcast
    return TestClient(app)


def main():
    db = make_db()
    broadcast_events = []
    owner = make_client(db, user_id=1, broadcast_events=broadcast_events)

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
    assert_true(broadcast_events[-1]["event_type"] == "todo_comment_create", broadcast_events[-1])
    assert_true("reminders" not in broadcast_events[-1]["payload"], broadcast_events[-1])
    assert_true("location_reminders" not in broadcast_events[-1]["payload"], broadcast_events[-1])

    idempotent_payload = {"body": "Offline retry note", "client_mutation_id": "temp-comment-offline-1"}
    idempotent_first = owner.post(f"/api/todos/{todo_id}/comments", json=idempotent_payload)
    idempotent_retry = owner.post(f"/api/todos/{todo_id}/comments", json={**idempotent_payload, "body": "Must not duplicate"})
    assert_true(idempotent_first.status_code == 200, idempotent_first.text)
    assert_true(idempotent_retry.status_code == 200, idempotent_retry.text)
    assert_true(idempotent_retry.json()["comment"]["id"] == idempotent_first.json()["comment"]["id"], idempotent_retry.json())
    assert_true(idempotent_retry.json()["comment"]["body"] == "Offline retry note", idempotent_retry.json())
    idempotent_cleanup = owner.delete(f"/api/todos/{todo_id}/comments/{idempotent_first.json()['comment']['id']}")
    assert_true(idempotent_cleanup.status_code == 200, idempotent_cleanup.text)

    listed = owner.get("/api/todos")
    assert_true(listed.status_code == 200, listed.text)
    listed_todo = next(todo for todo in listed.json()["todos"] if todo["id"] == todo_id)
    assert_true(listed_todo["comments_count"] == 1, listed_todo)

    member = make_client(db, user_id=2, broadcast_events=broadcast_events)
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
    assert_true(broadcast_events[-1]["event_type"] == "todo_comment_update", broadcast_events[-1])

    stranger = make_client(db, user_id=3, broadcast_events=broadcast_events)
    forbidden = stranger.post(f"/api/todos/{todo_id}/comments", json={"body": "Nope"})
    assert_true(forbidden.status_code in (403, 404), forbidden.text)

    member_cannot_delete_owner_comment = member.delete(f"/api/todos/{todo_id}/comments/{comment_id}")
    assert_true(member_cannot_delete_owner_comment.status_code == 403, member_cannot_delete_owner_comment.text)

    owner_can_delete_member_comment = owner.delete(f"/api/todos/{todo_id}/comments/{member_comment_id}")
    assert_true(owner_can_delete_member_comment.status_code == 200, owner_can_delete_member_comment.text)
    assert_true(owner_can_delete_member_comment.json()["todo"]["comments_count"] == 1, owner_can_delete_member_comment.text)
    assert_true(broadcast_events[-1]["event_type"] == "todo_comment_delete", broadcast_events[-1])

    second_member_comment = member.post(f"/api/todos/{todo_id}/comments", json={"body": "Member disposable note"})
    assert_true(second_member_comment.status_code == 200, second_member_comment.text)
    second_member_comment_id = second_member_comment.json()["comment"]["id"]
    member_can_delete_own_comment = member.delete(f"/api/todos/{todo_id}/comments/{second_member_comment_id}")
    assert_true(member_can_delete_own_comment.status_code == 200, member_can_delete_own_comment.text)
    assert_true(member_can_delete_own_comment.json()["todo"]["comments_count"] == 1, member_can_delete_own_comment.text)

    deleted = owner.delete(f"/api/todos/{todo_id}/comments/{comment_id}")
    assert_true(deleted.status_code == 200, deleted.text)
    assert_true(deleted.json()["todo"]["comments_count"] == 0, deleted.text)
    repeated_delete = owner.delete(f"/api/todos/{todo_id}/comments/{comment_id}")
    assert_true(repeated_delete.status_code == 404, repeated_delete.text)

    empty = owner.post(f"/api/todos/{todo_id}/comments", json={"body": "   "})
    assert_true(empty.status_code == 422, empty.text)
    comment_event_types = [event["event_type"] for event in broadcast_events if event["event_type"].startswith("todo_comment_")]
    assert_true(comment_event_types, broadcast_events)
    assert_true("todo_update" not in comment_event_types, broadcast_events)

    print("✅ Todo comments API tests passed")


if __name__ == "__main__":
    main()
