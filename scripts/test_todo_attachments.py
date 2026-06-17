#!/usr/bin/env python3
"""Todo attachments API regression tests."""

from __future__ import annotations

import contextlib
import sqlite3
import sys
import tempfile
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
            default_reminder_offset_minutes INTEGER,
            attachment_quota_bytes INTEGER
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
        CREATE TABLE todo_attachments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            todo_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            original_filename TEXT NOT NULL,
            stored_filename TEXT NOT NULL,
            content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
            size_bytes INTEGER NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
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
        CREATE TABLE app_config (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        );
        """
    )
    db.execute("INSERT INTO users (id, username, display_name, default_reminder_offset_minutes, attachment_quota_bytes) VALUES (1, 'owner', 'Owner Display', NULL, NULL)")
    db.execute("INSERT INTO users (id, username, display_name, default_reminder_offset_minutes, attachment_quota_bytes) VALUES (2, 'member', 'Member Display', NULL, NULL)")
    db.execute("INSERT INTO users (id, username, display_name, default_reminder_offset_minutes, attachment_quota_bytes) VALUES (3, 'stranger', 'Stranger Display', NULL, NULL)")
    db.execute("INSERT INTO projects (id, name, user_id, is_inbox) VALUES (1, 'Inbox', 1, 1)")
    db.execute("INSERT INTO projects (id, name, user_id, is_inbox) VALUES (2, 'Shared', 1, 0)")
    db.execute("INSERT INTO project_members (project_id, user_id, status) VALUES (2, 2, 'accepted')")
    db.execute("INSERT INTO app_config (key, value) VALUES ('attachments_enabled', '1')")
    db.execute("INSERT INTO app_config (key, value) VALUES ('attachments_allowed_types', '[\"image/*\",\"application/pdf\",\"text/plain\"]')")
    db.execute("INSERT INTO app_config (key, value) VALUES ('attachments_default_quota_bytes', '5368709120')")
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
    with tempfile.TemporaryDirectory() as tmp:
        todos_router.ATTACHMENT_DIR = Path(tmp)
        owner = make_client(db, user_id=1, broadcast_events=broadcast_events)

        created = owner.post("/api/todos", json={"title": "Collect documents", "project_id": 2})
        assert_true(created.status_code == 200, created.text)
        todo_id = created.json()["id"]

        uploaded = owner.post(
            f"/api/todos/{todo_id}/attachments",
            content=b"hello attachment",
            headers={"content-type": "text/plain", "x-nia-filename": "notes.txt"},
        )
        assert_true(uploaded.status_code == 200, uploaded.text)
        body = uploaded.json()
        attachment_id = body["attachment"]["id"]
        assert_true(body["attachment"]["original_filename"] == "notes.txt", body)
        assert_true(body["attachment"]["size_bytes"] == len(b"hello attachment"), body)
        assert_true(body["todo"]["attachments_count"] == 1, body)
        assert_true(body["todo"]["attachments"][0]["uploader_display_name"] == "Owner Display", body)
        assert_true(broadcast_events[-1]["event_type"] == "todo_attachment_create", broadcast_events[-1])
        assert_true("stored_filename" not in broadcast_events[-1]["payload"]["attachment"], broadcast_events[-1])

        listed = owner.get("/api/todos")
        assert_true(listed.status_code == 200, listed.text)
        listed_todo = next(todo for todo in listed.json()["todos"] if todo["id"] == todo_id)
        assert_true(listed_todo["attachments_count"] == 1, listed_todo)

        downloaded = owner.get(f"/api/todos/{todo_id}/attachments/{attachment_id}/download")
        assert_true(downloaded.status_code == 200, downloaded.text)
        assert_true(downloaded.content == b"hello attachment", downloaded.content)
        assert_true(downloaded.headers["content-type"].startswith("text/plain"), downloaded.headers)

        member = make_client(db, user_id=2, broadcast_events=broadcast_events)
        member_download = member.get(f"/api/todos/{todo_id}/attachments/{attachment_id}/download")
        assert_true(member_download.status_code == 200, member_download.text)
        assert_true(member_download.content == b"hello attachment", member_download.content)

        member_delete_owner_attachment = member.delete(f"/api/todos/{todo_id}/attachments/{attachment_id}")
        assert_true(member_delete_owner_attachment.status_code == 200, member_delete_owner_attachment.text)
        attachment_id = owner.post(
            f"/api/todos/{todo_id}/attachments",
            content=b"hello attachment again",
            headers={"content-type": "text/plain", "x-nia-filename": "notes.txt"},
        ).json()["attachment"]["id"]

        member_upload = member.post(
            f"/api/todos/{todo_id}/attachments",
            content=b"member file",
            headers={"content-type": "text/plain", "x-nia-filename": "../member.txt"},
        )
        assert_true(member_upload.status_code == 200, member_upload.text)
        member_attachment_id = member_upload.json()["attachment"]["id"]
        assert_true(member_upload.json()["attachment"]["original_filename"] == "member.txt", member_upload.text)

        owner_delete_member_attachment = owner.delete(f"/api/todos/{todo_id}/attachments/{member_attachment_id}")
        assert_true(owner_delete_member_attachment.status_code == 200, owner_delete_member_attachment.text)
        assert_true(owner_delete_member_attachment.json()["todo"]["attachments_count"] == 1, owner_delete_member_attachment.text)
        assert_true(broadcast_events[-1]["event_type"] == "todo_attachment_delete", broadcast_events[-1])

        stranger = make_client(db, user_id=3, broadcast_events=broadcast_events)
        forbidden = stranger.post(
            f"/api/todos/{todo_id}/attachments",
            content=b"nope",
            headers={"content-type": "text/plain", "x-nia-filename": "nope.txt"},
        )
        assert_true(forbidden.status_code == 404, forbidden.text)

        blocked_type = owner.post(
            f"/api/todos/{todo_id}/attachments",
            content=b"<svg></svg>",
            headers={"content-type": "image/svg+xml", "x-nia-filename": "bad.svg"},
        )
        assert_true(blocked_type.status_code == 415, blocked_type.text)

        db.execute("UPDATE users SET attachment_quota_bytes = ? WHERE id = 1", (10,))
        db.commit()
        quota_blocked = owner.post(
            f"/api/todos/{todo_id}/attachments",
            content=b"more than ten bytes",
            headers={"content-type": "text/plain", "x-nia-filename": "quota.txt"},
        )
        assert_true(quota_blocked.status_code == 413, quota_blocked.text)
        db.execute("UPDATE users SET attachment_quota_bytes = NULL WHERE id = 1")
        db.execute("UPDATE app_config SET value = '0' WHERE key = 'attachments_enabled'")
        db.commit()
        disabled_upload = owner.post(
            f"/api/todos/{todo_id}/attachments",
            content=b"disabled",
            headers={"content-type": "text/plain", "x-nia-filename": "disabled.txt"},
        )
        assert_true(disabled_upload.status_code == 403, disabled_upload.text)
        db.execute("UPDATE app_config SET value = '1' WHERE key = 'attachments_enabled'")
        db.commit()

        deleted = owner.delete(f"/api/todos/{todo_id}/attachments/{attachment_id}")
        assert_true(deleted.status_code == 200, deleted.text)
        assert_true(deleted.json()["todo"]["attachments_count"] == 0, deleted.text)

        missing_download = owner.get(f"/api/todos/{todo_id}/attachments/{attachment_id}/download")
        assert_true(missing_download.status_code == 404, missing_download.text)

    print("✅ Todo attachments API tests passed")


if __name__ == "__main__":
    main()
